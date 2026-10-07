import {
  balanceReader,
  FetchRefused,
  payAndFetch,
  readCurrentPeriods,
  readLiveness,
  usdcBalance,
  usdcForNetwork,
} from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { createPublicClient, http, type Address } from 'viem';
import { normalize } from 'viem/ens';
import { mainnet } from 'viem/chains';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { currentGrant, type Grant } from '@/grants/store';
import { publicClientFor } from '@/lib/chain';
import { fenceText, reply } from '@/lib/fence';
import { safeFetch } from '@/lib/safe-fetch';

const caip2 = (chainId: number) => `eip155:${chainId}`;
const caip19 = (network: string, token: string) => `${network}/erc20:${token}`;

const money = z.object({
  amount: z.string().describe('Base units, decimal string'),
  asset: z.string().describe('CAIP-19 asset id'),
});
const readiness = z.object({
  status: z.enum(['ready', 'not_ready']),
  reason: z.enum(['no_grant', 'grant_revoked', 'chain_unavailable']).optional(),
  link: z.string().url().optional(),
});
type Readiness = z.infer<typeof readiness>;

const budgetOutput = z.object({
  permissionId: z.string(),
  perDay: money,
  spentToday: money.nullable().describe('What the permission manager counts as spent in the current day'),
  remainingToday: money.nullable(),
  resetsAt: z.string().nullable(),
  expiresAt: z.string(),
});

const clients = { clients: { publicClient: publicClientFor } };

async function budgetOf(grant: Grant) {
  const target = { chainId: grant.chainId, permissionId: grant.permissionId, permission: grant.permission };
  const [liveness, periods] = await Promise.all([
    readLiveness(target, clients),
    readCurrentPeriods({ ...target, token: grant.token }, clients),
  ]);
  const asset = caip19(caip2(grant.chainId), grant.token);
  const counted = periods[0]?.period;
  const spent = counted?.status === 'ok' ? counted.spend : counted?.status === 'outside-window' ? 0n : null;
  const allowance = BigInt(grant.allowance);
  const left = spent === null ? null : spent >= allowance ? 0n : allowance - spent;
  return {
    liveness,
    budget: budgetOutput.parse({
      permissionId: grant.permissionId,
      perDay: { amount: grant.allowance, asset },
      spentToday: spent === null ? null : { amount: spent.toString(), asset },
      remainingToday: left === null ? null : { amount: left.toString(), asset },
      resetsAt: counted?.status === 'ok' ? new Date((counted.end + 1) * 1000).toISOString() : null,
      expiresAt: grant.expiresAt.toISOString(),
    }),
  };
}

function readinessOf(liveness: Awaited<ReturnType<typeof readLiveness>> | undefined): Readiness {
  if (liveness === undefined) return { status: 'not_ready', reason: 'no_grant' };
  if (liveness === 'active') return { status: 'ready' };
  if (liveness === 'unknown') return { status: 'not_ready', reason: 'chain_unavailable' };
  return { status: 'not_ready', reason: 'grant_revoked' };
}

async function readinessFor(t: Tenant): Promise<Readiness> {
  const grant = await currentGrant(t.connectionId);
  return readinessOf(grant && (await budgetOf(grant)).liveness);
}

const fenced = (source: string, text: string) => ({ type: 'text' as const, text: fenceText(source, text, 2000) });

async function balanceOf(network: string, owner: Address) {
  const read = balanceReader({ publicClient: publicClientFor });
  return usdcBalance(network, owner, read)
    .then((b) => ({ amount: b.raw, asset: caip19(network, b.asset) }))
    .catch(() => null);
}

const statusOutput = z.object({
  account: z.string(),
  chainId: z.string().describe('CAIP-2'),
  sessionAddress: z.string().describe('The address this connection pays from once it has a budget'),
  balances: z.object({ account: money.nullable(), session: money.nullable() }),
  budget: budgetOutput.nullable(),
  readiness,
  summary: z.string(),
});

const NOT_READY: Record<NonNullable<Readiness['reason']>, string> = {
  no_grant: 'No budget yet: ask for one with jaw_request_budget.',
  grant_revoked: 'The budget was revoked: ask for a new one with jaw_request_budget.',
  chain_unavailable: 'The budget could not be read from the chain right now.',
};

async function status(t: Tenant) {
  const network = caip2(t.chainId);
  const [account, session, grant] = await Promise.all([
    balanceOf(network, t.account),
    balanceOf(network, t.sessionAddress),
    currentGrant(t.connectionId),
  ]);
  const read = grant && (await budgetOf(grant));
  const ready = readinessOf(read?.liveness);
  const left = read?.budget.remainingToday;
  return statusOutput.parse({
    account: t.account,
    chainId: network,
    sessionAddress: t.sessionAddress,
    balances: { account, session },
    budget: read?.budget ?? null,
    readiness: ready,
    summary:
      ready.status === 'ready'
        ? `Connected as ${t.account} on ${network}. Ready to pay${left ? `, ${left.amount} base units left today` : ''}.`
        : `Connected as ${t.account} on ${network}. ${NOT_READY[ready.reason ?? 'no_grant']}`,
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
  const outcome = await payAndFetch(url, payer, {
    dryRun: true,
    network,
    fetch: safeFetch(config().insecureFetchHosts),
  }).catch((err: unknown) => {
    // A fixed reason per code: the error text would tell a client which internal names resolve.
    const refused = err instanceof FetchRefused;
    return {
      kind: 'unreachable' as const,
      code: refused ? 'blocked_url' : 'unreachable',
      reason: refused ? 'The URL is not allowed.' : 'The URL could not be reached.',
    };
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
  return {
    out: quoteOutput.parse({ ...base, kind: 'free', summary: `Free: answered ${outcome.status} without a payment.` }),
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

async function resolveName(name: string) {
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
    'jaw_status',
    {
      description:
        'The connected account, its USDC balances, and whether this connection can pay yet (with a link when not).',
      inputSchema: z.strictObject({}),
      outputSchema: statusOutput,
      annotations: readOnly,
    },
    async (_args, ctx) => reply(await status(tenant(ctx)))
  );

  server.registerTool(
    'jaw_quote',
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

  server.registerTool(
    'jaw_resolve_name',
    {
      description: 'Resolve an ENS name to an address on Ethereum mainnet.',
      inputSchema: z.strictObject({ name: z.string().max(255) }),
      outputSchema: resolveOutput,
      annotations: readOnly,
    },
    async ({ name }) => {
      try {
        return reply(await resolveName(name));
      } catch {
        return refusal('Not a valid ENS name, or the lookup failed.');
      }
    }
  );
}
