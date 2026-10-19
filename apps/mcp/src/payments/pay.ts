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
import { after } from 'next/server';
import type { Address, Hex } from 'viem';
import { agentLogger, chainClients, payerFor, sessionOf, topUpExecutor, withoutUrls } from '@/adapters/session-host';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { countHit, isPaymentsPaused } from '@/db/settings';
import { liveGrants, x402Budget, type Grant } from '@/grants/store';
import { errorLabel, log, RATE_WINDOW_MS } from '@/lib/edge';
import { fenceText } from '@/lib/fence';
import { safeFetch, watchCuts } from '@/lib/safe-fetch';
import { confirmByReceipt, type Settled } from './confirm';
import { refillHook } from './refill';
import { gate, render, resent, type PayResult } from './render';
import {
  claim,
  entriesFor,
  findPayment,
  finish,
  txHashTaken,
  markSigned,
  release,
  settle,
  PAY_LIMIT_MS,
  type Conclusion,
  type PaymentRequest,
  type PaymentRow,
} from './store';

export { payOutput } from './render';

export const PAY_RATE_LIMIT = 30;
const CONFIRM_MS = 3_000;
// How long the receipt is awaited once the answer is out, before the reconciler takes over.
const LATE_CONFIRM_MS = 30_000;
const BODY_MAX = 8_000;
const STORED_BODY_MAX = 16_384;

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
  /** Runs a task after the response is sent. */
  later: Confirm['later'];
}

/** Where a paid row's receipt is read: briefly in the call, and once more after the answer is out. */
interface Confirm {
  clients: ChainClients;
  later: (task: () => Promise<void>) => void;
}

const liveDeps = (): PayDeps => ({
  clients: chainClients,
  readPermission: (target) => readPermissionState(target, { clients: chainClients }),
  floatTarget: config().floatTarget,
  executor: topUpExecutor,
  fetch: safeFetch(config().insecureFetchHosts),
  later: after,
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

// Final even unsigned: a larger budget, not a retry, is what pays it; a refill
// that threw may have moved money that no trace shows.
const FINAL_UNSIGNED = new Set(['budget_exhausted', 'funding_failed']);

/** Where the outcome leaves a row. `signed` says whether an authorization for it exists. */
function conclusionOf(o: Outcome, signed: boolean, settled: Settled | undefined, noRetry: boolean): Conclusion {
  const traces = {
    topUp: 'topUp' in o ? o.topUp : undefined,
    approvalBatchId: 'permit2Approval' in o ? o.permit2Approval?.batchId : undefined,
  };
  const retry =
    !noRetry &&
    !traces.topUp &&
    !traces.approvalBatchId &&
    !(o.kind === 'refused' && FINAL_UNSIGNED.has(o.refusal.code));
  const refused = signed ? 'unknown' : retry ? 'pending' : 'failed';
  if (o.kind === 'unreached') return { state: refused, kind: 'refused', code: o.code };
  switch (o.kind) {
    case 'free':
    case 'would-pay':
      return { state: 'settled', kind: 'free', httpStatus: o.status };
    case 'refused':
      // Refused after signing: the proof may have left in a call that crashed. Only the chain can say.
      return {
        state: refused,
        kind: 'refused',
        code: o.refusal.code,
        httpStatus: o.status,
        ...traces,
      };
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

async function settledBy(
  o: Outcome,
  signedAfter: Date,
  clients: ChainClients,
  timeoutMs: number
): Promise<Settled | undefined> {
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
  return confirmByReceipt(attempt, payment.txHash as Hex, clients, timeoutMs);
}

/** A hash another payment of this payer already settled on proves nothing about this one, so it is dropped. */
async function claimedHashOnly(o: Outcome, rowId: string): Promise<Outcome> {
  if (o.kind !== 'paid' || !o.payment.txHash) return o;
  // The seller was paid already, so a hash that cannot be checked is dropped like a taken one.
  const taken = await txHashTaken(o.payer, o.payment.txHash, rowId).catch((err: unknown) => {
    log('warn', { msg: `payment ${rowId} hash not checked`, error: errorLabel(err) });
    return true;
  });
  if (!taken) return o;
  return { ...o, payment: { ...o.payment, txHash: undefined } };
}

/** When another call concluded the row first, its answer is the row's; this call's only if the row is gone. */
async function rowAfter(row: PaymentRow, c: Conclusion): Promise<PaymentRow> {
  const current = await findPayment(row.id);
  return current && current.state !== 'pending' ? current : merged(current ?? row, c);
}

/** The row as the signing write left it, from the proof this call sent, when the database cannot be read. */
function signedAs(row: PaymentRow, o: Outcome): PaymentRow {
  const sent = o.kind === 'paid' ? o.payment : o.kind === 'failed' ? o.attempted : undefined;
  if (!sent || row.nonce) return row;
  const { nonce, authorized, scheme, asset, network, payTo } = sent;
  return { ...row, nonce: nonce.toLowerCase(), authorized, scheme, asset, network, payTo };
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
  body: c.body ?? row.body,
});

function tapBodies(inner: typeof fetch) {
  let last: Promise<string | undefined> = Promise.resolve(undefined);
  const tapped: typeof fetch = async (input, init) => {
    last = Promise.resolve(undefined);
    const res = await inner(input, init);
    last = textUpTo(res.clone(), STORED_BODY_MAX).catch(() => undefined);
    return res;
  };
  return { fetch: tapped, last: () => last };
}

async function textUpTo(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  // Postgres text columns reject NUL.
  const text = Buffer.concat(chunks).toString('utf-8').replaceAll('\u0000', '\uFFFD');
  return Buffer.byteLength(text) > max ? undefined : text;
}

/** One `jaw_session_x402_pay` call, from the gates to an answer drawn from its row. */
export async function pay(
  t: Tenant,
  input: PayInput,
  deps: PayDeps = liveDeps(),
  { keepBody = false } = {}
): Promise<PayResult> {
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
  const grant = await x402Budget(t.connectionId);
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
  const tap = tapBodies(deps.fetch);
  const cuts = watchCuts(keepBody ? tap.fetch : deps.fetch);
  const sent = { method: request.method, headers: request.headers, body: request.body, budget, fetch: cuts.fetch };
  const confirm = { clients: deps.clients, later: deps.later };

  if (claimed.kind === 'resume') {
    // The proof goes out again only while the budget it was signed under is live,
    // which a newer budget no longer ends.
    const signedUnder = (await liveGrants(t.connectionId)).find((g) => g.permissionId === claimed.row.permissionId);
    const stopped: Unreached | undefined = signedUnder
      ? await grantLive(signedUnder, deps)
      : { kind: 'unreached', code: 'no_grant', reason: 'the budget this payment was signed under ended' };
    return resend(claimed.row, claimed.token, stopped, payer, sent, confirm, cuts.lastCut, tap.last);
  }

  const { row, token } = claimed;
  let signed = false;
  const outcome: Outcome = grant
    ? ((await grantLive(grant, deps)) ??
      (await payWithinGrant(t, grant, row, token, request, payer, sent, deps, () => (signed = true))))
    : { kind: 'unreached', code: 'no_grant', reason: 'the budget ended while this payment waited' };
  const done = await concludeSend(row, token, outcome, {
    signed,
    signedAt: new Date(started),
    confirm,
    raw: tap.last,
  });
  return render(done.row, done.fenced, cuts.lastCut());
}

/**
 * The tail of every send: the conclusion written from the outcome, and the row
 * it left.
 */
async function concludeSend(
  row: PaymentRow,
  token: string,
  outcome: Outcome,
  opts: { signed: boolean; signedAt: Date; confirm: Confirm; raw: () => Promise<string | undefined> }
): Promise<{ row: PaymentRow; fenced: string[] }> {
  const checked = await claimedHashOnly(outcome, row.id);
  const settled = await settledBy(checked, opts.signedAt, opts.confirm.clients, CONFIRM_MS);
  const movedBefore = Boolean(row.topUpAmount || row.topUpBatchId || row.approvalBatchId);
  const conclusion = conclusionOf(checked, opts.signed, settled, movedBefore);
  conclusion.body = await opts.raw();
  const fenced = fencedOf(row.url, outcome);
  let written: PaymentRow | undefined;
  try {
    written = await finish(row.id, token, conclusion, fenced);
  } catch (err) {
    // The caller still gets what this call reached. The row keeps what it had,
    // and its lease ends so a retry or the reconciler can take it.
    log('error', { msg: `payment ${row.id} not concluded`, error: errorLabel(err) });
    await release(row.id, token).catch((e) => {
      log('warn', { msg: `payment ${row.id} lease not released`, error: errorLabel(e) });
    });
    const stored = (await findPayment(row.id).catch(() => undefined)) ?? signedAs(row, outcome);
    settleLater(stored, checked, opts.signedAt, opts.confirm);
    const shown = merged(stored, conclusion);
    // Settled only once the row says so: until then the answer says it is being confirmed.
    if (shown.state === 'settled' && stored.state === 'signed') shown.state = 'signed';
    return { row: shown, fenced };
  }
  if (written) settleLater(written, checked, opts.signedAt, opts.confirm);
  return { row: written ?? (await rowAfter(row, conclusion)), fenced };
}

/** A receipt the call could not wait for, read again once the answer is out. The reconciler covers what this misses. */
function settleLater(row: PaymentRow, o: Outcome, signedAt: Date, { clients, later }: Confirm) {
  if (row.state !== 'signed') return;
  const task = async () => {
    const settled = await settledBy(o, signedAt, clients, LATE_CONFIRM_MS);
    if (settled) await settle(row.id, settled);
  };
  // The payment is already written, so a task that cannot be scheduled must not fail the call.
  try {
    later(() =>
      task().catch((err) => {
        log('error', { msg: `late settle ${row.id} failed`, error: err instanceof Error ? err.name : 'unknown' });
      })
    );
  } catch (err) {
    log('warn', { msg: `late settle ${row.id} not scheduled`, error: err instanceof Error ? err.name : 'unknown' });
  }
}

/** A previous call signed for this row and got no answer: the same proof again, under the same key. */
async function resend(
  row: PaymentRow,
  token: string,
  stopped: Unreached | undefined,
  payer: Payer,
  sent: Parameters<typeof payAndFetch>[2],
  confirm: Confirm,
  lastCut: () => boolean,
  raw: () => Promise<string | undefined>
): Promise<PayResult> {
  const authorization = row.authorization as SignedAuthorization;
  const outcome: Outcome =
    stopped ??
    (await payAndFetch(authorization.resource, payer, {
      ...sent,
      attempt: { key: row.id, resume: authorization },
    }).catch(thrown));
  // A refused resend says nothing about the first send, which the chain or a live first call settles.
  if (outcome.kind !== 'paid') {
    await release(row.id, token);
    const answer = render(
      merged(row, conclusionOf(outcome, true, undefined, false)),
      fencedOf(row.url, outcome),
      lastCut()
    );
    return { ...answer, [resent]: true };
  }
  const done = await concludeSend(row, token, outcome, {
    signed: true,
    signedAt: row.signedAt as Date,
    confirm,
    raw,
  });
  return render(done.row, done.fenced, lastCut());
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
