import {
  balanceReader,
  type OnChainPeriod,
  payAndFetch,
  readCurrentPeriods,
  readLiveness,
  usdcBalance,
  usdcForNetwork,
  within,
} from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { createPublicClient, http, type Address } from 'viem';
import { normalize } from 'viem/ens';
import { mainnet } from 'viem/chains';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { findActive } from '@/connections/rows';
import { getDb } from '@/db/client';
import { liveGrants, x402Budget, type Grant, type LiveGrant } from '@/grants/store';
import { dayLeft, daySpendOf, isoOf } from '@/payments/day-spend';
import { chainView, heldSpends, LOGGED_READ_MS, readAt, recordedSends } from '@/payments/sends';
import { entriesFor, pulledUnderOtherGrants } from '@/payments/store';
import { publicClientFor } from '@/lib/chain';
import { fenceText, reply } from '@/lib/fence';
import { safeFetch, watchCuts } from '@/lib/safe-fetch';

const caip2 = (chainId: number) => `eip155:${chainId}`;
const caip19 = (network: string, token: string) => `${network}/erc20:${token}`;

const money = z.object({
  amount: z.string().describe('Base units, decimal string'),
  asset: z.string().describe('CAIP-19 asset id'),
});
const readiness = z.object({
  status: z.enum(['ready', 'not_ready']),
  reason: z.enum(['no_scope', 'no_grant', 'grant_revoked', 'chain_unavailable']).optional(),
  link: z.string().url().optional(),
});
type Readiness = z.infer<typeof readiness>;

const budgetOutput = z.object({
  permissionId: z.string(),
  perDay: money,
  spentToday: money.nullable().describe('What left this budget today'),
  remainingToday: money.nullable().describe('The most the next payment can spend today'),
  resetsAt: z.string().nullable(),
  expiresAt: z.string(),
});

const clients = { clients: { publicClient: publicClientFor } };

const floorZero = (n: bigint) => (n > 0n ? n : 0n);
const least = (a: bigint, b: bigint) => (a < b ? a : b);

// A session balance that could not be read counts as empty.
async function budgetOf(grant: Grant, t: Tenant, held: bigint | null) {
  const target = { chainId: grant.chainId, permissionId: grant.permissionId, permission: grant.permission };
  const [liveness, periods, earlier, entries, sent] = await Promise.all([
    readLiveness(target, clients),
    readCurrentPeriods({ ...target, token: grant.token }, clients),
    pulledUnderOtherGrants(getDb(), t.connectionId, grant.permissionId),
    entriesFor(grant.permissionId),
    recordedSends(grant.permissionId),
  ]);
  const asset = caip19(caip2(grant.chainId), grant.token);
  const counted = periods[0]?.period;
  const day = daySpendOf(counted, entries, sent, { permissionId: grant.permissionId, payer: t.sessionAddress });
  const allowance = BigInt(grant.allowance);
  const figure = (amount: bigint) => ({ amount: amount.toString(), asset });
  let spent = null;
  let payable = null;
  if (day) {
    const pulled = day.refilled + day.sentFromAccount;
    const left = dayLeft(allowance, day);
    const pullable = floorZero(allowance - pulled);
    const floatFundable = (held ?? 0n) + floorZero(pullable - earlier);
    spent = figure(day.paid + day.sentFromAccount);
    payable = figure(least(left, floatFundable));
  }
  return {
    liveness,
    budget: budgetOutput.parse({
      permissionId: grant.permissionId,
      perDay: { amount: grant.allowance, asset },
      spentToday: spent,
      remainingToday: payable,
      resetsAt: (counted?.status === 'ok' && isoOf(counted.end + 1)) || null,
      expiresAt: grant.expiresAt.toISOString(),
    }),
  };
}

function readinessOf(t: Tenant, liveness: Awaited<ReturnType<typeof readLiveness>> | undefined): Readiness {
  if (!t.scopes.includes('x402:pay')) return { status: 'not_ready', reason: 'no_scope' };
  if (liveness === undefined) return { status: 'not_ready', reason: 'no_grant' };
  if (liveness === 'active') return { status: 'ready' };
  if (liveness === 'unknown') return { status: 'not_ready', reason: 'chain_unavailable' };
  return { status: 'not_ready', reason: 'grant_revoked' };
}

async function readinessFor(t: Tenant): Promise<Readiness> {
  const grant = await x402Budget(t.connectionId);
  return readinessOf(t, grant && (await budgetOf(grant, t, null)).liveness);
}

const fenced = (source: string, text: string) => ({ type: 'text' as const, text: fenceText(source, text, 2000) });

async function balanceOf(network: string, owner: Address) {
  const read = balanceReader({ publicClient: publicClientFor });
  return usdcBalance(network, owner, read)
    .then((b) => ({ amount: b.raw, asset: caip19(network, b.asset) }))
    .catch(() => null);
}

const limitOut = z.object({
  asset: z.string().describe('CAIP-19 asset id'),
  unit: z.string(),
  multiplier: z.number(),
  allowance: z.string().describe('Base units per period'),
  left: z
    .string()
    .nullable()
    .describe(
      'Base units the session key can still spend under this limit this period, executes in flight counted; null when unreadable. An x402 budget reports its `budget.remainingToday`'
    ),
});
const grantOut = z.object({
  permissionId: z.string(),
  kind: z.enum(['x402-budget', 'custom']),
  chainId: z.string().describe('CAIP-2'),
  active: z.boolean().nullable().describe('The chain still approves it; null when the chain could not be read'),
  expiresAt: z.string(),
  limits: z.array(limitOut),
});

const statusOutput = z.object({
  account: z.string(),
  chainId: z.string().describe('CAIP-2'),
  sessionAddress: z.string().describe('The address this connection pays from once it has a budget'),
  connectionExpiresAt: z.string().describe('When this connection expires; call jaw_session_disconnect before then'),
  float: money.nullable().describe('USDC held at the session address, which pays before the account is pulled from'),
  grants: z.array(grantOut).describe('Every live grant on this connection, with what each limit has left'),
  budget: budgetOutput.nullable(),
  readiness,
  summary: z.string(),
});

const NOT_READY: Record<NonNullable<Readiness['reason']>, string> = {
  no_scope: 'Paying needs the x402:pay scope: reconnect and ask for it.',
  no_grant: 'No budget yet: ask for one with jaw_grant_permissions and x402Budget.',
  grant_revoked: 'The budget was revoked: ask for a new one with jaw_grant_permissions and x402Budget.',
  chain_unavailable: 'The budget could not be read from the chain right now.',
};

function leftToday(budget: z.infer<typeof budgetOutput> | undefined) {
  const pay = budget?.remainingToday;
  return pay ? `, ${pay.amount} base units left today` : '';
}

const EXPIRY_WARN_MS = 48 * 60 * 60 * 1000;

function leftOf(period: OnChainPeriod, allowance: bigint, inFlight: bigint) {
  if (period.status === 'unavailable') return null;
  return period.status === 'ok' ? floorZero(allowance - period.spend - inFlight).toString() : '0';
}

// A run the logs show counts in the period spend read at their block, not again as held.
async function grantOf(connectionId: string, g: LiveGrant): Promise<z.infer<typeof grantOut>> {
  const target = { chainId: g.chainId, permissionId: g.permissionId, permission: g.permission };
  const tokens = [...new Set(g.permission.spends.map((s) => s.token.toLowerCase()))];
  const view = await within(chainView(connectionId, g.permissionId, g.chainId, clients.clients), LOGGED_READ_MS).catch(
    () => undefined
  );
  const read = readAt(clients.clients, g.chainId, view?.head);
  const [liveness, periods, open] = await Promise.all([
    readLiveness(target, read),
    Promise.all(tokens.map((token) => readCurrentPeriods({ ...target, token }, read))),
    heldSpends(g.permissionId, getDb(), view?.seen),
  ]);
  return {
    permissionId: g.permissionId,
    kind: g.kind,
    chainId: caip2(g.chainId),
    active: liveness === 'unknown' || liveness === 'mismatch' ? null : liveness === 'active',
    expiresAt: g.expiresAt.toISOString(),
    limits: periods.flat().map(({ token, unit, multiplier, allowance, period }) => ({
      asset: caip19(caip2(g.chainId), token),
      unit,
      multiplier,
      allowance,
      left: leftOf(period, BigInt(allowance), open.get(token.toLowerCase()) ?? 0n),
    })),
  };
}

async function status(t: Tenant) {
  const network = caip2(t.chainId);
  const [float, grant, held, conn] = await Promise.all([
    balanceOf(network, t.sessionAddress),
    x402Budget(t.connectionId),
    liveGrants(t.connectionId),
    findActive(t.connectionId),
  ]);
  const [read, shown] = await Promise.all([
    grant && budgetOf(grant, t, float && BigInt(float.amount)),
    Promise.all(held.map((g) => grantOf(t.connectionId, g))),
  ]);
  const grants = shown.map((g) =>
    g.permissionId === grant?.permissionId
      ? { ...g, limits: g.limits.map((l) => ({ ...l, left: read?.budget.remainingToday?.amount ?? null })) }
      : g
  );
  const ready = readinessOf(t, read?.liveness);
  const expiresAt = conn?.expiresAt ?? new Date();
  const nearExpiry = expiresAt.getTime() - Date.now() < EXPIRY_WARN_MS;
  const base =
    ready.status === 'ready'
      ? `Connected as ${t.account} on ${network}. Ready to pay${leftToday(read?.budget)}.`
      : `Connected as ${t.account} on ${network}. ${NOT_READY[ready.reason ?? 'no_grant']}`;
  const summary = nearExpiry
    ? `${base} Connection expires ${expiresAt.toISOString()}; call jaw_session_disconnect soon.`
    : base;
  return statusOutput.parse({
    account: t.account,
    chainId: network,
    sessionAddress: t.sessionAddress,
    connectionExpiresAt: expiresAt.toISOString(),
    float,
    grants,
    budget: read?.budget ?? null,
    readiness: ready,
    summary,
  });
}

const quoteOutput = z.object({
  url: z.string(),
  kind: z.enum(['paid', 'free', 'refused']),
  price: money.optional(),
  chainId: z.string().optional(),
  scheme: z.string().optional(),
  payTo: z.string().optional(),
  refusal: z.object({ code: z.string(), reason: z.string() }).optional(),
  bodyTruncated: z
    .literal(true)
    .optional()
    .describe('Present when the free body was over 1 MB and was cut there before it was read'),
  readiness,
  summary: z.string(),
});

async function quote(t: Tenant, url: string) {
  const network = caip2(t.chainId);
  // A dry run stops before funding or signing, so this payer is never asked to pay.
  const payer = {
    address: t.sessionAddress,
    pay: () => Promise.reject(new Error('a quote never pays')),
  };
  const base = { url, readiness: await readinessFor(t) };
  const cuts = watchCuts(safeFetch(config().insecureFetchHosts));
  const outcome = await payAndFetch(url, payer, { dryRun: true, network, fetch: cuts.fetch }).catch(() => {
    // One answer for every failure: telling a refused address from a failed lookup
    // would tell a client which internal names resolve.
    return { kind: 'unreachable' as const, code: 'unreachable', reason: 'The URL could not be fetched.' };
  });
  if (outcome.kind === 'unreachable') {
    return {
      out: quoteOutput.parse({
        ...base,
        kind: 'refused',
        refusal: { code: outcome.code, reason: outcome.reason },
        summary: `No quote: ${outcome.code}.`,
      }),
    };
  }
  if (outcome.kind === 'would-pay') {
    const p = outcome.wouldPay;
    const asset = usdcForNetwork(p.network);
    const shown = asset && asset.address.toLowerCase() === p.asset.toLowerCase() ? asset.usdcName : p.asset;
    return {
      out: quoteOutput.parse({
        ...base,
        kind: 'paid',
        price: { amount: p.amount, asset: caip19(p.network, p.asset) },
        chainId: p.network,
        scheme: p.scheme,
        payTo: p.payTo,
        summary: `Costs ${p.amount} base units of ${shown} on ${p.network}. Not paid.`,
      }),
    };
  }
  if (outcome.kind === 'refused') {
    return {
      out: quoteOutput.parse({
        ...base,
        kind: 'refused',
        refusal: { code: outcome.refusal.code, reason: fenceText(new URL(url).host, outcome.refusal.reason, 400) },
        summary: `No quote: ${outcome.refusal.code}.`,
      }),
      extra: [fenced(new URL(url).host, outcome.refusal.reason)],
    };
  }
  const cut = cuts.lastCut();
  return {
    out: quoteOutput.parse({
      ...base,
      kind: 'free',
      ...(cut && { bodyTruncated: true }),
      summary: `Free: answered ${outcome.status} without a payment.${cut ? ' The body was cut at 1 MB.' : ''}`,
    }),
    extra: [fenced(new URL(url).host, typeof outcome.body === 'string' ? outcome.body : JSON.stringify(outcome.body))],
  };
}

const addFundsOutput = z.object({
  address: z.string(),
  chains: z.array(z.string()).describe('CAIP-2 chains this address accepts deposits on'),
  asset: z.string().describe('CAIP-19 asset to send'),
  paymentUri: z.string().describe('EIP-681 URI'),
  summary: z.string(),
});

function addFunds(t: Tenant) {
  const network = caip2(t.chainId);
  const usdc = usdcForNetwork(network);
  if (!usdc) return undefined;
  return addFundsOutput.parse({
    address: t.account,
    chains: [network],
    asset: caip19(network, usdc.address),
    // EIP-681 ERC-20 transfer: a wallet that opens it sends USDC, not ETH, to the account.
    paymentUri: `ethereum:${usdc.address}@${t.chainId}/transfer?address=${t.account}`,
    summary: `Send USDC on ${network} to ${t.account}.`,
  });
}

const resolveOutput = z.object({
  name: z.string(),
  address: z.string().nullable(),
  chainId: z.string(),
  summary: z.string(),
});

/** Resolves an ENS name on mainnet. Not a tool: resolving a name is a service the agent pays for. */
export async function resolveName(name: string) {
  const normalized = normalize(name);
  const client = createPublicClient({ chain: mainnet, transport: http(config().mainnetRpcUrl) });
  const address = await client.getEnsAddress({ name: normalized });
  return resolveOutput.parse({
    name: normalized,
    address: address ?? null,
    chainId: caip2(mainnet.id),
    summary: address ? `Resolves to ${address}.` : 'The name has no address.',
  });
}

const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const readOnly = { readOnlyHint: true, openWorldHint: true };

export function registerReadTools(server: McpServer) {
  server.registerTool(
    'jaw_session_status',
    {
      description:
        'This connection: its expiry, every live grant with what each limit has left, the USDC float at its session address, and whether it can pay yet (with a link when not). Balances are in jaw_get_assets.',
      inputSchema: z.strictObject({}),
      outputSchema: statusOutput,
      annotations: readOnly,
    },
    async (_args, ctx) => reply(await status(tenant(ctx)))
  );

  server.registerTool(
    'jaw_session_x402_quote',
    {
      description: 'The price of an x402 resource, without paying. Sends one request and reads the 402 challenge.',
      inputSchema: z.strictObject({ url: z.string().url().describe('The paid resource') }),
      outputSchema: quoteOutput,
      annotations: readOnly,
    },
    async ({ url }, ctx) => {
      const { out, extra = [] } = await quote(tenant(ctx), url);
      return reply(out, ...extra);
    }
  );

  server.registerTool(
    'jaw_add_funds',
    {
      description: 'Where to send USDC to fund the connected account. No fiat on-ramp.',
      inputSchema: z.strictObject({}),
      outputSchema: addFundsOutput,
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const out = addFunds(tenant(ctx));
      return out ? reply(out) : refusal("USDC is not supported on this connection's chain.");
    }
  );
}
