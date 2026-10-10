import { randomBytes } from 'node:crypto';
import {
  currentLimitUsageOnChain,
  errorMessage,
  FetchRefused,
  payAndFetch,
  readPermissionState,
  resolveSessionX402Policy,
  sumSpentSince,
  until,
  type ChainClients,
  type PaymentOutcome,
  type PermissionReadTarget,
  type PermissionState,
  type Payer,
  type SignedAuthorization,
  type TopUpExecutor,
} from '@jaw.id/agent';
import type { Address, Hex } from 'viem';
import { agentLogger, chainClients, payerFor, sessionOf, topUpExecutor, withoutUrls } from '@/adapters/session-host';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { countHit, isPaymentsPaused } from '@/db/settings';
import { currentGrant, type Grant } from '@/grants/store';
import { log, RATE_WINDOW_MS } from '@/lib/edge';
import { fenceText } from '@/lib/fence';
import { safeFetch } from '@/lib/safe-fetch';
import { confirmByReceipt, type Settled } from './confirm';
import { refillHook } from './refill';
import { offerOneOff } from './one-off';
import { gate, render, type PayResult } from './render';
import {
  claim,
  entriesFor,
  findPayment,
  finish,
  txHashTaken,
  markSigned,
  release,
  PAY_LIMIT_MS,
  type Conclusion,
  type PaymentRequest,
  type PaymentRow,
} from './store';

export { payOutput } from './render';

export const PAY_RATE_LIMIT = 30;
const CONFIRM_MS = 3_000;
const BODY_MAX = 8_000;

// Reasons built from our own errors can quote an RPC or paymaster url, key included.
const SERVER_REASONS = new Set([
  'funding_failed',
  'signing_failed',
  'chain_unavailable',
  'store_failed',
  'timed_out',
  'unreachable',
  'no_response',
  'not_allowed',
]);

export interface PayInput {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  maxAmount?: string;
  idempotencyKey?: string;
}

export interface PayDeps {
  clients: ChainClients;
  readPermission: (target: PermissionReadTarget) => Promise<PermissionState>;
  floatTarget: bigint;
  executor: (t: Tenant, grant: Grant) => TopUpExecutor | undefined;
  fetch: typeof fetch;
}

const liveDeps = (): PayDeps => ({
  clients: chainClients,
  readPermission: (target) => readPermissionState(target, { clients: chainClients }),
  floatTarget: config().floatTarget,
  executor: topUpExecutor,
  fetch: safeFetch(config().insecureFetchHosts),
});

/** The probe never answered, or the grant was gone: nothing was signed. */
type Unreached = {
  kind: 'unreached';
  code: 'blocked_url' | 'unreachable' | 'no_grant' | 'grant_revoked' | 'chain_unavailable';
  reason: string;
};

// A revoke on chain stops payments within this long, without a chain read on every call.
const LIVE_FOR_MS = 30_000;
const liveUntil = new Map<string, number>();

/** Whether the grant is still approved and not revoked on chain, the permission manager's own answer. */
async function grantLive(grant: Grant, deps: PayDeps): Promise<Unreached | undefined> {
  if ((liveUntil.get(grant.permissionId) ?? 0) > Date.now()) return undefined;
  const state = await deps
    .readPermission({ chainId: grant.chainId, permissionId: grant.permissionId, permission: grant.permission })
    .catch((): PermissionState => ({ status: 'unavailable' }));
  if (state.status === 'unavailable') {
    return { kind: 'unreached', code: 'chain_unavailable', reason: 'the budget could not be read from the chain' };
  }
  if (state.status === 'mismatch' || !state.approved || state.revoked) {
    return { kind: 'unreached', code: 'grant_revoked', reason: 'the budget is no longer approved on chain' };
  }
  liveUntil.set(grant.permissionId, Date.now() + LIVE_FOR_MS);
  return undefined;
}
type Outcome = PaymentOutcome | Unreached;

export const thrown = (err: unknown): Unreached => ({
  kind: 'unreached',
  code: err instanceof FetchRefused ? 'blocked_url' : 'unreachable',
  reason: errorMessage(err),
});

const codeOf = (o: Outcome) => (o.kind === 'unreached' ? o.code : 'refusal' in o ? o.refusal.code : undefined);

/** The seller's body and reason, fenced once, so a replay repeats the same words. */
function fencedOf(url: string, o: Outcome): string[] {
  const host = new URL(url).host;
  const fenced: string[] = [];
  if ('body' in o && o.body !== undefined && o.body !== '') {
    fenced.push(fenceText(host, typeof o.body === 'string' ? o.body : JSON.stringify(o.body), BODY_MAX));
  }
  const code = codeOf(o);
  const reason = o.kind === 'unreached' ? o.reason : 'refusal' in o ? o.refusal.reason : '';
  if (reason && code && SERVER_REASONS.has(code)) {
    log('warn', { msg: `payment ${code}: ${withoutUrls(reason)}` });
  } else if (reason) {
    fenced.push(fenceText(host, reason, 400));
  }
  return fenced;
}

// Final even unsigned: budget_exhausted carries a one-off offer, which a retry would open
// again; a refill that threw may have moved money that no trace shows.
const FINAL_UNSIGNED = new Set(['budget_exhausted', 'funding_failed']);

/** Where the outcome leaves a row. `signed` says whether an authorization for it exists. */
function conclusionOf(o: Outcome, signed: boolean, settled: Settled | undefined): Conclusion {
  if (o.kind === 'unreached') return { state: signed ? 'unknown' : 'pending', kind: 'refused', code: o.code };
  const traces = {
    topUp: 'topUp' in o ? o.topUp : undefined,
    approvalBatchId: 'permit2Approval' in o ? o.permit2Approval?.batchId : undefined,
  };
  switch (o.kind) {
    case 'free':
    case 'would-pay':
      return { state: 'settled', kind: 'free', httpStatus: o.status };
    case 'refused': {
      const retry = !traces.topUp && !traces.approvalBatchId && !FINAL_UNSIGNED.has(o.refusal.code);
      // Refused after signing: the proof may have left in a call that crashed. Only the chain can say.
      return {
        state: signed ? 'unknown' : retry ? 'pending' : 'failed',
        kind: 'refused',
        code: o.refusal.code,
        httpStatus: o.status,
        ...traces,
      };
    }
    case 'failed':
      return {
        state: o.refusal.code === 'no_response' ? 'signed' : 'unknown',
        kind: 'failed',
        code: o.refusal.code,
        httpStatus: o.status,
        amount: o.attempted.amount,
        ...traces,
      };
    case 'paid':
      return {
        state: settled ? 'settled' : 'signed',
        kind: 'paid',
        httpStatus: o.status,
        amount: settled ? settled.amount.toString() : o.payment.amount,
        txHash: settled?.txHash ?? o.payment.txHash,
        blockTime: settled?.blockTime,
        ...traces,
      };
  }
}

async function settledBy(o: Outcome, signedAfter: Date, clients: ChainClients): Promise<Settled | undefined> {
  if (o.kind !== 'paid' || !o.payment.txHash) return undefined;
  const { payment } = o;
  const attempt = {
    payer: o.payer,
    nonce: payment.nonce,
    scheme: payment.scheme,
    network: payment.network,
    payTo: payment.payTo as Address,
    authorized: BigInt(payment.authorized),
    signedAt: signedAfter,
  };
  return confirmByReceipt(attempt, payment.txHash as Hex, clients, CONFIRM_MS);
}

/** A hash another payment of this payer already settled on proves nothing about this one, so it is dropped. */
async function claimedHashOnly(o: Outcome, rowId: string): Promise<Outcome> {
  if (o.kind !== 'paid' || !o.payment.txHash) return o;
  if (!(await txHashTaken(o.payer, o.payment.txHash, rowId))) return o;
  return { ...o, payment: { ...o.payment, txHash: undefined } };
}

/** When another call concluded the row first, its answer is the row's; this call's only if the row is gone. */
async function rowAfter(row: PaymentRow, c: Conclusion): Promise<PaymentRow> {
  const current = await findPayment(row.id);
  return current && current.state !== 'pending' ? current : merged(current ?? row, c);
}

const merged = (row: PaymentRow, c: Conclusion): PaymentRow => ({
  ...row,
  state: c.state,
  kind: c.kind,
  code: c.code ?? null,
  httpStatus: c.httpStatus ?? null,
  amount: c.amount ?? row.amount,
  txHash: c.txHash ?? row.txHash,
  blockTime: c.blockTime ?? row.blockTime,
  topUpAmount: row.topUpAmount ?? c.topUp?.amount ?? null,
  topUpBatchId: row.topUpBatchId ?? c.topUp?.batchId ?? null,
  approvalBatchId: row.approvalBatchId ?? c.approvalBatchId ?? null,
});

/** One `jaw_pay_and_fetch` call, from the gates to an answer drawn from its row. */
export async function pay(t: Tenant, input: PayInput, deps: PayDeps = liveDeps()): Promise<PayResult> {
  if (!t.scopes.includes('x402:pay')) {
    return gate(
      'insufficient_scope',
      'This token was not granted x402:pay. Reconnect and ask for it to pay from a budget; a budget approved on this connection does not carry over to the new one.'
    );
  }
  if (await isPaymentsPaused())
    return gate('payments_paused', 'Payments are paused on this server. Nothing was signed.');
  if ((await countHit(`pay:${t.connectionId}`, RATE_WINDOW_MS)) > PAY_RATE_LIMIT) {
    return gate('rate_limited', 'Too many payments on this connection. Wait a minute.');
  }
  const request: PaymentRequest = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: input.headers ?? {},
    body: input.body,
    maxAmount: input.maxAmount,
  };
  const key = input.idempotencyKey ?? `auto_${randomBytes(12).toString('base64url')}`;
  const grant = await currentGrant(t.connectionId);
  const claimed = await claim(
    { connectionId: t.connectionId, payer: t.sessionAddress, permissionId: grant?.permissionId },
    key,
    request
  );
  switch (claimed.kind) {
    case 'conflict':
      return gate('idempotency_conflict', 'This idempotency key was used for another request. Nothing was sent.');
    case 'busy':
      return gate('in_progress', 'A call with this idempotency key is still running. Try again shortly.');
    case 'no_grant':
      return gate('no_grant', 'This connection has no budget yet. Ask for one with jaw_request_budget.');
    case 'stored':
      return render(claimed.row, claimed.row.fenced ?? []);
  }

  const started = Date.now();
  const budget = until(started + PAY_LIMIT_MS);
  const payer = payerFor(t, deps.clients);
  const sent = { method: request.method, headers: request.headers, body: request.body, budget, fetch: deps.fetch };

  if (claimed.kind === 'resume') return resend(claimed.row, claimed.token, payer, sent, deps.clients);

  const { row, token } = claimed;
  let signed = false;
  const outcome: Outcome = grant
    ? ((await grantLive(grant, deps)) ??
      (await payWithinGrant(t, grant, row, token, request, payer, sent, deps, () => (signed = true))))
    : { kind: 'unreached', code: 'no_grant', reason: 'the budget ended while this payment waited' };
  const done = await concludeSend(row, token, outcome, {
    signed,
    signedAt: new Date(started),
    confirmWith: deps.clients,
  });
  const offer =
    outcome.kind === 'refused' && outcome.refusal.code === 'budget_exhausted' && outcome.challenge
      ? await offerOneOff(t, request, outcome.challenge)
      : undefined;
  return render(done.row, done.fenced, offer);
}

/**
 * The tail of every send: the conclusion written from the outcome, and the row
 * it left. Without `confirmWith` a paid row stays signed for the reconciler.
 */
export async function concludeSend(
  row: PaymentRow,
  token: string,
  outcome: Outcome,
  opts: { signed: boolean; signedAt: Date; confirmWith?: ChainClients }
): Promise<{ row: PaymentRow; fenced: string[] }> {
  const checked = await claimedHashOnly(outcome, row.id);
  const settled = opts.confirmWith ? await settledBy(checked, opts.signedAt, opts.confirmWith) : undefined;
  const conclusion = conclusionOf(checked, opts.signed, settled);
  const fenced = fencedOf(row.url, outcome);
  const written = await finish(row.id, token, conclusion, fenced);
  return { row: written ?? (await rowAfter(row, conclusion)), fenced };
}

/** A previous call signed for this row and got no answer: the same proof again, under the same key. */
export async function resend(
  row: PaymentRow,
  token: string,
  payer: Payer,
  sent: Parameters<typeof payAndFetch>[2],
  confirmWith?: ChainClients
): Promise<PayResult> {
  const authorization = row.authorization as SignedAuthorization;
  const outcome: Outcome = await payAndFetch(authorization.resource, payer, {
    ...sent,
    attempt: { key: row.id, resume: authorization },
  }).catch(thrown);
  // A refused resend says nothing about the first send, which the chain or a live first call settles.
  if (outcome.kind !== 'paid') {
    await release(row.id, token);
    return render(merged(row, conclusionOf(outcome, true, undefined)), fencedOf(row.url, outcome));
  }
  const done = await concludeSend(row, token, outcome, { signed: true, signedAt: row.signedAt as Date, confirmWith });
  return render(done.row, done.fenced);
}

async function payWithinGrant(
  t: Tenant,
  grant: Grant,
  row: PaymentRow,
  token: string,
  request: PaymentRequest,
  payer: ReturnType<typeof payerFor>,
  sent: Parameters<typeof payAndFetch>[2],
  deps: PayDeps,
  onSigned: () => void
): Promise<Outcome> {
  const session = sessionOf(grant);
  // Seeded from the grant alone: nothing a tool call sends can widen it. maxAmount only tightens.
  const policy = resolveSessionX402Policy(undefined, session);
  const entries = await entriesFor(grant.permissionId);
  const periodUsage = await currentLimitUsageOnChain(entries, policy, payer.address, session, new Date(), {
    clients: deps.clients,
  });
  const executor = deps.executor(t, grant);
  return payAndFetch(request.url, payer, {
    ...sent,
    policy,
    periodUsage,
    spentThisSession: sumSpentSince(entries, { payer: payer.address }, session.createdAt),
    maxAmount: request.maxAmount,
    network: `eip155:${grant.chainId}`,
    ensureFunds: refillHook({
      rowId: row.id,
      token,
      connectionId: t.connectionId,
      payer: payer.address,
      grant,
      policy,
      executor,
      floatTarget: deps.floatTarget,
      clients: deps.clients,
      logger: agentLogger,
    }),
    attempt: {
      key: row.id,
      onSigned: async (authorization) => {
        await markSigned(row.id, token, authorization);
        onSigned();
      },
    },
  }).catch(thrown);
}
