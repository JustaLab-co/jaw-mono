import { randomBytes } from 'node:crypto';
import {
  currentLimitUsageOnChain,
  errorMessage,
  FetchRefused,
  payAndFetch,
  resolveSessionX402Policy,
  sumSpentSince,
  until,
  type ChainClients,
  type PaymentDetails,
  type PaymentOutcome,
  type SignedAuthorization,
  type TopUpExecutor,
} from '@jaw.id/agent';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { agentLogger, chainClients, payerFor, sessionOf, topUpExecutor } from '@/adapters/session-host';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { countHit, isPaymentsPaused } from '@/db/settings';
import { currentGrant, type Grant } from '@/grants/store';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { fenceText } from '@/lib/fence';
import { safeFetch } from '@/lib/safe-fetch';
import { confirmByReceipt } from './confirm';
import { refillHook } from './refill';
import {
  claim,
  entriesFor,
  finish,
  markSigned,
  PAY_LIMIT_MS,
  type Conclusion,
  type PaymentRequest,
  type PaymentRow,
} from './store';

export const PAY_RATE_LIMIT = 30;
const CONFIRM_MS = 3_000;
const BODY_MAX = 8_000;

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
  executor: (t: Tenant, grant: Grant) => TopUpExecutor | undefined;
  fetch: typeof fetch;
}

const liveDeps = (): PayDeps => ({
  clients: chainClients,
  executor: topUpExecutor,
  fetch: safeFetch(config().insecureFetchHosts),
});

const money = z.object({ amount: z.string(), asset: z.string().describe('CAIP-19 asset id') });

export const payOutput = z.object({
  paymentId: z.string(),
  idempotencyKey: z.string().describe('Send it again to retry this payment without paying twice'),
  state: z.enum(['pending', 'signed', 'settled', 'failed', 'unknown']),
  kind: z.enum(['free', 'paid', 'refused', 'failed']),
  httpStatus: z.number().int().nullable(),
  payment: money
    .extend({
      authorized: z.string(),
      payTo: z.string(),
      nonce: z.string(),
      txHash: z.string().optional(),
      blockTime: z.string().optional(),
    })
    .optional(),
  refusal: z.object({ code: z.string(), next: z.literal('jaw_request_budget').optional() }).optional(),
  topUp: z.object({ amount: z.string().optional(), batchId: z.string().optional() }).optional(),
  moneyMoved: z.boolean().describe('Funds moved from the account into the payer, whatever the outcome'),
  summary: z.string(),
});
type PayOutput = z.infer<typeof payOutput>;

type Text = { type: 'text'; text: string };

/** The probe never answered, or the grant was gone: nothing was signed. */
type Unreached = { kind: 'unreached'; code: 'blocked_url' | 'unreachable' | 'no_grant'; reason: string };
type Outcome = PaymentOutcome | Unreached;
export type PayResult = { content: Text[]; structuredContent?: PayOutput; isError?: boolean };

const RAISE = new Set(['budget_exhausted', 'over_cap', 'no_grant']);

const gate = (code: string, text: string): PayResult => ({
  content: [{ type: 'text', text: `${code}: ${text}` }],
  isError: true,
});

const caip19 = (network: string, asset: string) => `${network}/erc20:${asset}`;

function summaryOf(out: Omit<PayOutput, 'summary'>): string {
  const moved = out.moneyMoved ? ' Funds moved into the payer first.' : '';
  if (out.kind === 'free') return `Free: answered ${out.httpStatus} without a payment.`;
  if (out.kind === 'paid') {
    const settled = out.state === 'settled' ? `Settled in ${out.payment?.txHash}.` : 'Settlement is being confirmed.';
    return `Paid ${out.payment?.amount} base units to ${out.payment?.payTo}. ${settled}${moved}`;
  }
  const code = out.refusal?.code;
  const raise = out.refusal?.next ? ' Ask for a larger budget with jaw_request_budget.' : '';
  if (out.kind === 'refused') return `Not paid: ${code}. Nothing was sent.${raise}${moved}`;
  return `A payment was sent and not confirmed: ${code}. It may still settle; jaw_history shows it.${moved}`;
}

/** What a call has to show beyond its row: the signed details, and the seller's own text. */
interface Shown {
  details?: PaymentDetails;
  body?: unknown;
  reason?: string;
}

function shownOf(outcome: Outcome): Shown {
  if (outcome.kind === 'unreached') return { reason: outcome.reason };
  return {
    details: 'payment' in outcome ? outcome.payment : 'attempted' in outcome ? outcome.attempted : undefined,
    body: outcome.body,
    reason: 'refusal' in outcome ? outcome.refusal.reason : undefined,
  };
}

function render(row: PaymentRow, conclusion: Conclusion, { details, body, reason }: Shown): PayResult {
  const out = {
    paymentId: row.id,
    idempotencyKey: row.idempotencyKey,
    state: conclusion.state,
    kind: conclusion.kind,
    httpStatus: conclusion.httpStatus ?? null,
    ...(details && {
      payment: {
        amount: conclusion.amount ?? details.amount,
        asset: caip19(details.network, details.asset),
        authorized: details.authorized,
        payTo: details.payTo,
        nonce: details.nonce,
        ...(conclusion.txHash && { txHash: conclusion.txHash }),
        ...(conclusion.blockTime && { blockTime: conclusion.blockTime.toISOString() }),
      },
    }),
    ...(conclusion.code && {
      refusal: { code: conclusion.code, ...(RAISE.has(conclusion.code) && { next: 'jaw_request_budget' as const }) },
    }),
    ...(conclusion.topUp && { topUp: conclusion.topUp }),
    moneyMoved: conclusion.topUp !== undefined || conclusion.approvalBatchId !== undefined,
  };
  const host = new URL(row.url).host;
  const extra: Text[] = [];
  if (body !== undefined && body !== '') {
    extra.push({
      type: 'text',
      text: fenceText(host, typeof body === 'string' ? body : JSON.stringify(body), BODY_MAX),
    });
  }
  if (reason) extra.push({ type: 'text', text: fenceText(host, reason, 400) });
  const structured = payOutput.parse({ ...out, summary: summaryOf(out) });
  return { content: [{ type: 'text', text: structured.summary }, ...extra], structuredContent: structured };
}

/** A row a later reconciliation finished after its caller went away: no body to return. */
function renderStored(row: PaymentRow): PayResult {
  if (row.result) return row.result as PayResult;
  const authorization = row.authorization as SignedAuthorization | null;
  const conclusion: Conclusion = {
    state: row.state,
    kind: row.kind ?? 'failed',
    code: row.code ?? undefined,
    httpStatus: row.httpStatus ?? undefined,
    amount: row.amount ?? undefined,
    txHash: row.txHash ?? undefined,
    blockTime: row.blockTime ?? undefined,
  };
  return render(row, conclusion, { details: authorization?.details });
}

/** Where the outcome leaves the row. `signed` says whether an authorization for it exists. */
async function conclude(
  outcome: Outcome,
  signed: boolean,
  clients: ChainClients
): Promise<Omit<Conclusion, 'result'> & { storeResult: boolean }> {
  const traces = {
    topUp: 'topUp' in outcome ? outcome.topUp : undefined,
    approvalBatchId: 'permit2Approval' in outcome ? outcome.permit2Approval?.batchId : undefined,
  };
  switch (outcome.kind) {
    case 'unreached':
      return { state: 'failed', kind: 'refused', code: outcome.code, storeResult: true };
    case 'free':
    case 'would-pay':
      return { state: 'settled', kind: 'free', httpStatus: outcome.status, storeResult: true };
    case 'refused':
      // Refused after signing: the proof may have left in a call that crashed. Only the chain can say.
      return {
        state: signed ? 'unknown' : 'failed',
        kind: 'refused',
        code: outcome.refusal.code,
        httpStatus: outcome.status,
        ...traces,
        storeResult: true,
      };
    case 'failed':
      return {
        state: outcome.refusal.code === 'no_response' ? 'signed' : 'unknown',
        kind: 'failed',
        code: outcome.refusal.code,
        httpStatus: outcome.status,
        amount: outcome.attempted.amount,
        ...traces,
        // A lost answer is resent by the next call with this key, so nothing is stored for it.
        storeResult: outcome.refusal.code !== 'no_response',
      };
    case 'paid': {
      const { payment } = outcome;
      const settled = payment.txHash
        ? await confirmByReceipt(
            {
              payer: outcome.payer,
              nonce: payment.nonce,
              scheme: payment.scheme,
              network: payment.network,
              payTo: payment.payTo as Address,
              authorized: BigInt(payment.authorized),
            },
            payment.txHash as Hex,
            clients,
            CONFIRM_MS
          )
        : undefined;
      return {
        state: settled ? 'settled' : 'signed',
        kind: 'paid',
        httpStatus: outcome.status,
        amount: settled ? settled.amount.toString() : payment.amount,
        txHash: settled?.txHash ?? payment.txHash,
        blockTime: settled?.blockTime,
        ...traces,
        storeResult: true,
      };
    }
  }
}

const thrown = (err: unknown): Unreached => ({
  kind: 'unreached',
  code: err instanceof FetchRefused ? 'blocked_url' : 'unreachable',
  reason: errorMessage(err),
});

/** One `jaw_pay_and_fetch` call, from the gates to a stored answer. */
export async function pay(t: Tenant, input: PayInput, deps: PayDeps = liveDeps()): Promise<PayResult> {
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
      return renderStored(claimed.row);
  }

  const started = Date.now();
  const budget = until(started + PAY_LIMIT_MS);
  const payer = payerFor(t, deps.clients);
  const sent = { method: request.method, headers: request.headers, body: request.body, budget, fetch: deps.fetch };
  let signed = claimed.kind === 'resume';
  let outcome: Outcome;
  if (claimed.kind === 'resume') {
    outcome = await payAndFetch(claimed.authorization.resource, payer, {
      ...sent,
      attempt: { key: claimed.row.id, resume: claimed.authorization },
    }).catch(thrown);
  } else {
    const { row, token } = claimed;
    outcome = grant
      ? await payWithinGrant(t, grant, row, token, request, payer, sent, deps, () => (signed = true))
      : { kind: 'unreached', code: 'no_grant', reason: 'the budget ended while this payment waited' };
  }

  const { storeResult, ...conclusion } = await conclude(outcome, signed, deps.clients);
  const result = render(claimed.row, conclusion, shownOf(outcome));
  const token = claimed.kind === 'run' ? claimed.token : '';
  if (!(await finish(claimed.row.id, token, { ...conclusion, result: storeResult ? result : undefined }))) {
    return gate('in_progress', 'Another call with this idempotency key finished first. Send it again to read it.');
  }
  return result;
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
  const entries = await entriesFor(grant.permissionId, new Date());
  const periodUsage = await currentLimitUsageOnChain(entries, policy, payer.address, session, new Date(), {
    clients: deps.clients,
  });
  const spentThisSession = sumSpentSince(entries, { payer: payer.address }, session.createdAt);
  const executor = deps.executor(t, grant);
  return payAndFetch(request.url, payer, {
    ...sent,
    policy,
    periodUsage,
    spentThisSession,
    maxAmount: request.maxAmount,
    network: `eip155:${grant.chainId}`,
    ensureFunds:
      executor &&
      refillHook({
        rowId: row.id,
        token,
        connectionId: t.connectionId,
        payer: payer.address,
        grant,
        policy,
        periodUsage,
        spentThisSession,
        executor,
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
