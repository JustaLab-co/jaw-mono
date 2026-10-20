import {
  balanceReader,
  currentLimitUsageOnChain,
  firstOperationCost,
  gasReserve,
  type OnChainPeriod,
  PERMIT2_ADDRESS,
  payAndFetch,
  type PaymentOutcome,
  readCurrentPeriods,
  readLiveness,
  resolveSessionX402Policy,
  sumSpentSince,
  usdcBalance,
  usdcForNetwork,
} from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { erc20Abi, type Address } from 'viem';
import { z } from 'zod';
import { chainClients, sessionOf } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { findActive } from '@/connections/rows';
import { getDb } from '@/db/client';
import { liveGrants, x402Budget, type Grant, type LiveGrant } from '@/grants/store';
import { dayLeft, daySpendOf, isoOf } from '@/payments/day-spend';
import { stillHeld } from '@/payments/refill';
import { openSpends, recordedSends, type OpenSpend } from '@/payments/sends';
import { entriesFor, holdingRows, pulledUnderOtherGrants } from '@/payments/store';
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
const quoteReadinessOut = readiness.extend({
  reason: z
    .enum([
      ...readiness.shape.reason.unwrap().options,
      'over_allowance',
      'over_cap',
      'balance_low',
      'funding_unavailable',
    ])
    .optional(),
});
type QuoteReadiness = z.infer<typeof quoteReadinessOut>;

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

/**
 * What today leaves: the day's allowance, the float at the session address that no
 * other payment holds (null when unread), and what a refill may still pull.
 */
interface Room {
  left: bigint;
  held: bigint | null;
  cap: bigint;
}

// A refill pays the fee for its own transfer, so the cap has to hold that on top of what it pulls.
function refillFee(grant: Grant) {
  const usdc = usdcForNetwork(caip2(grant.chainId));
  return usdc ? firstOperationCost(usdc) : 0n;
}

// remainingToday counts a session balance that could not be read as empty.
async function budgetOf(grant: Grant, t: Tenant, balance: bigint | null) {
  const target = { chainId: grant.chainId, permissionId: grant.permissionId, permission: grant.permission };
  const [liveness, periods, earlier, entries, sent, holds] = await Promise.all([
    readLiveness(target, clients),
    readCurrentPeriods({ ...target, token: grant.token }, clients),
    pulledUnderOtherGrants(getDb(), t.connectionId, grant.permissionId),
    entriesFor(grant.permissionId),
    recordedSends(grant.permissionId),
    holdingRows(getDb(), t.sessionAddress, '').then((rows) => stillHeld(rows, chainClients, undefined)),
  ]);
  const asset = caip19(caip2(grant.chainId), grant.token);
  const counted = periods[0]?.period;
  const day = daySpendOf(counted, entries, sent, { permissionId: grant.permissionId, payer: t.sessionAddress });
  const allowance = BigInt(grant.allowance);
  const figure = (amount: bigint) => ({ amount: amount.toString(), asset });
  let spent = null;
  let payable = null;
  let room: Room | undefined;
  if (day) {
    const pulled = day.refilled + day.sentFromAccount;
    const held = balance === null ? null : floorZero(balance - holds);
    room = { left: dayLeft(allowance, day), held, cap: floorZero(floorZero(allowance - pulled) - earlier) };
    spent = figure(day.paid + day.sentFromAccount);
    payable = figure(least(room.left, (held ?? 0n) + floorZero(room.cap - refillFee(grant))));
  }
  return {
    liveness,
    room,
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

function leftOf(period: OnChainPeriod, allowance: bigint, open: OpenSpend[], token: string) {
  if (period.status === 'unavailable') return null;
  if (period.status !== 'ok') return '0';
  // Same rule as fit: an open send holds allowance only in the period it was recorded in.
  const held = open
    .filter((p) => p.token.toLowerCase() === token && p.periodStart >= period.start && p.periodStart < period.end)
    .reduce((sum, p) => sum + p.amount, 0n);
  return floorZero(allowance - period.spend - held).toString();
}

async function grantOf(g: LiveGrant): Promise<z.infer<typeof grantOut>> {
  const target = { chainId: g.chainId, permissionId: g.permissionId, permission: g.permission };
  const tokens = [...new Set(g.permission.spends.map((s) => s.token.toLowerCase()))];
  const [liveness, periods, open] = await Promise.all([
    readLiveness(target, clients),
    Promise.all(tokens.map((token) => readCurrentPeriods({ ...target, token }, clients))),
    openSpends(g.permissionId, getDb()),
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
      left: leftOf(period, BigInt(allowance), open, token.toLowerCase()),
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
    Promise.all(held.map(grantOf)),
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
  budget: z
    .object({ permissionId: z.string(), remainingToday: money.nullable() })
    .optional()
    .describe('The budget a payment would come from, on a paid quote'),
  readiness: quoteReadinessOut,
  summary: z.string(),
});

type BudgetRead = Awaited<ReturnType<typeof budgetOf>>;

type Price = { amount: string; asset: string; network: string; scheme: string; payTo: string };
type Fit = { readiness: QuoteReadiness; approvalOwed: boolean };
type Terms = Awaited<ReturnType<typeof termsOf>>;

const UNREADABLE: QuoteReadiness = { status: 'not_ready', reason: 'chain_unavailable' };
const NO_FUNDING: QuoteReadiness = { status: 'not_ready', reason: 'funding_unavailable' };
// Pay's own refusals at selection that still leave the quote a price to show.
const CAPPED: Record<string, QuoteReadiness> = {
  budget_exhausted: { status: 'not_ready', reason: 'over_allowance' },
  over_cap: { status: 'not_ready', reason: 'over_cap' },
};

/** The policy and usage pay measures a price against, built as payWithinGrant builds them. */
async function termsOf(grant: Grant, payer: Address) {
  const session = sessionOf(grant);
  const policy = resolveSessionX402Policy(undefined, session);
  const entries = await entriesFor(grant.permissionId);
  const periodUsage = await currentLimitUsageOnChain(entries, policy, payer, session, new Date(), clients);
  return { policy, periodUsage, spentThisSession: sumSpentSince(entries, { payer }, session.createdAt) };
}

/** Whether an upto payment must first approve Permit2 for the session, which pay reads the same way. */
async function permit2Owed(grant: Grant, owner: Address, price: bigint): Promise<boolean | undefined> {
  const allowance = await publicClientFor(grant.chainId)
    .readContract({ address: grant.token, abi: erc20Abi, functionName: 'allowance', args: [owner, PERMIT2_ADDRESS] })
    .catch(() => undefined);
  return allowance === undefined ? undefined : allowance < price;
}

// Pay's funding checks after selection, in its order: the day, the refill the float needs, the account behind it.
async function fitOf(t: Tenant, grant: Grant, room: Room | undefined, p: Price): Promise<Fit> {
  const fit = (readiness: QuoteReadiness, approvalOwed = false): Fit => ({ readiness, approvalOwed });
  if (!room || room.held === null) return fit(UNREADABLE);
  const price = BigInt(p.amount);
  const over: QuoteReadiness = { status: 'not_ready', reason: 'over_allowance' };
  if (price > room.left) return fit(over);
  const owed = p.scheme === 'upto' ? await permit2Owed(grant, t.sessionAddress, price) : false;
  if (owed === undefined) return fit(UNREADABLE);
  // Without a paymaster key the server can neither refill the session nor approve Permit2.
  const canFund = Boolean(config().paymasterApiKey);
  if (owed && !canFund) return fit(NO_FUNDING, owed);
  const usdc = usdcForNetwork(caip2(grant.chainId));
  const needed = owed && usdc ? price + gasReserve(usdc) : price;
  if (room.held >= needed) return fit({ status: 'ready' }, owed);
  if (!canFund) return fit(NO_FUNDING, owed);
  const pull = needed - room.held + refillFee(grant);
  if (pull > room.cap) return fit(over, owed);
  const funds = await balanceOf(caip2(grant.chainId), grant.account);
  if (!funds) return fit(UNREADABLE, owed);
  return fit(BigInt(funds.amount) < pull ? { status: 'not_ready', reason: 'balance_low' } : { status: 'ready' }, owed);
}

function fitSummary(read: BudgetRead, grant: Grant, terms: Terms, { readiness, approvalOwed }: Fit) {
  const { permissionId, remainingToday } = read.budget;
  const left = remainingToday ? `${remainingToday.amount} base units` : 'an unknown amount';
  const approval = approvalOwed ? ' A first upto payment also pays the gas to approve Permit2 from it.' : '';
  switch (readiness.reason) {
    case undefined:
      return ` Within budget ${permissionId}, which has ${left} left today.${approval}`;
    case 'over_allowance':
      return ` Budget ${permissionId} has ${left} left today, not enough to pay it.${approval}`;
    case 'over_cap':
      return ` One payment may spend at most ${terms.policy.maxAmountPerPayment} base units, whatever the budget.`;
    case 'balance_low':
      return ` The account ${grant.account} holds too little USDC to refill the session for it: send USDC there (jaw_add_funds).`;
    case 'funding_unavailable':
      return ' This server cannot refill the session or approve Permit2, so it pays only from the float already there.';
    default:
      return ` ${NOT_READY[readiness.reason]}`;
  }
}

type Priced = { price: Price; capped?: QuoteReadiness };

// The option pay would take: the one the dry run chose, or the cheapest of the budget's token when pay's caps refused it.
function pricedOf(outcome: PaymentOutcome, grant: Grant | undefined, network: string): Priced | undefined {
  if (outcome.kind === 'would-pay') return { price: outcome.wouldPay };
  const capped = outcome.kind === 'refused' ? CAPPED[outcome.refusal.code] : undefined;
  if (!grant || !capped || outcome.kind !== 'refused' || !outcome.challenge) return undefined;
  const [option] = outcome.challenge.accepts
    .filter((a) => a.network === network && a.asset.toLowerCase() === grant.token.toLowerCase())
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  return option && { price: option, capped };
}

async function fitFor(t: Tenant, grant: Grant, read: BudgetRead, priced: Priced): Promise<Fit> {
  if (priced.capped) return { readiness: priced.capped, approvalOwed: false };
  return fitOf(t, grant, read.room, priced.price);
}

async function quote(t: Tenant, url: string) {
  const network = caip2(t.chainId);
  // A dry run stops before funding or signing, so this payer is never asked to pay.
  const payer = {
    address: t.sessionAddress,
    pay: () => Promise.reject(new Error('a quote never pays')),
  };
  const grant = await x402Budget(t.connectionId);
  const [float, terms] = grant
    ? await Promise.all([balanceOf(caip2(grant.chainId), t.sessionAddress), termsOf(grant, t.sessionAddress)])
    : [null, undefined];
  const cuts = watchCuts(safeFetch(config().insecureFetchHosts));
  // Selected under the policy a payment runs, so the quote prices the option pay would take.
  const probe = payAndFetch(url, payer, { dryRun: true, network, ...terms, fetch: cuts.fetch }).catch(() => {
    // One answer for every failure: telling a refused address from a failed lookup
    // would tell a client which internal names resolve.
    return { kind: 'unreachable' as const, code: 'unreachable', reason: 'The URL could not be fetched.' };
  });
  const [outcome, read] = await Promise.all([probe, grant && budgetOf(grant, t, float && BigInt(float.amount))]);
  const ready = readinessOf(t, read?.liveness);
  const base = { url, readiness: ready };
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
  const priced = pricedOf(outcome, grant, network);
  if (priced) {
    const p = priced.price;
    const asset = usdcForNetwork(p.network);
    const shown = asset && asset.address.toLowerCase() === p.asset.toLowerCase() ? asset.usdcName : p.asset;
    const usable = grant && terms && read && ready.status === 'ready' ? { grant, terms, read } : undefined;
    const fit = usable && (await fitFor(t, usable.grant, usable.read, priced));
    return {
      out: quoteOutput.parse({
        ...base,
        readiness: fit?.readiness ?? ready,
        kind: 'paid',
        price: { amount: p.amount, asset: caip19(p.network, p.asset) },
        chainId: p.network,
        scheme: p.scheme,
        payTo: p.payTo,
        ...(usable && {
          budget: { permissionId: usable.read.budget.permissionId, remainingToday: usable.read.budget.remainingToday },
        }),
        summary: `Costs ${p.amount} base units of ${shown} on ${p.network}. Not paid.${usable && fit ? fitSummary(usable.read, usable.grant, usable.terms, fit) : ''}`,
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
      description:
        'The price of an x402 resource, without paying. Sends one request and reads the 402 challenge. ' +
        'readiness says whether jaw_session_x402_pay would pay it from this budget right now, and why not; it reserves nothing.',
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
