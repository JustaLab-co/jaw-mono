import { z } from 'zod';
import { stateOf, type PaymentRow } from './store';

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
  refusal: z
    .object({
      code: z.string(),
      next: z.literal('jaw_request_budget').optional(),
      oneOff: z
        .object({ requestId: z.string(), approveUrl: z.string().url() })
        .optional()
        .describe('The owner can pay this request once at approveUrl; poll jaw_request_status with requestId'),
    })
    .optional(),
  approvalId: z.string().optional().describe('The approval this one-off payment was paid under'),
  topUp: z.object({ amount: z.string().optional(), batchId: z.string().optional() }).optional(),
  moneyMoved: z.boolean().describe('Funds moved from the account into the payer, whatever the outcome'),
  summary: z.string(),
});
type PayOutput = z.infer<typeof payOutput>;

type Text = { type: 'text'; text: string };
export type OneOffOffer = { requestId: string; approveUrl: string };
/** The code of a refusal before anything was signed, for the audit record. A symbol key never reaches the client. */
export const gateCode = Symbol('gate code');
export type PayResult = { content: Text[]; structuredContent?: PayOutput; isError?: boolean; [gateCode]?: string };

/** Refusals a larger budget would fix. */
const RAISE = new Set(['budget_exhausted', 'no_grant', 'grant_revoked']);

export const gate = (code: string, text: string): PayResult => ({
  content: [{ type: 'text', text: `${code}: ${text}` }],
  isError: true,
  [gateCode]: code,
});

function summaryOf(row: PaymentRow, out: Omit<PayOutput, 'summary'>): string {
  const moved = out.moneyMoved ? ' Funds moved into the payer first.' : '';
  const paid = `${out.payment?.amount} base units to ${out.payment?.payTo}`;
  if (out.kind === 'free') return `Free: answered ${out.httpStatus} without a payment.`;
  const oneOff = out.refusal?.oneOff;
  const raise = out.refusal?.next ? ' Ask for a larger budget with jaw_request_budget.' : '';
  if (row.kind === null) return 'Paying now. Ask again in a few seconds.';
  switch (row.state) {
    case 'pending':
      return `Not paid: ${out.refusal?.code}. Nothing was sent. Send the same idempotencyKey again to retry.${raise}`;
    case 'settled':
      return `Paid ${paid}. Settled${out.payment?.txHash ? ` in ${out.payment.txHash}` : ' on chain'}.${moved}`;
    case 'signed':
      return out.kind === 'paid'
        ? `Paid ${paid}. Settlement is being confirmed; jaw_history shows it.${moved}`
        : `A payment was sent and no answer came back. Send the same idempotencyKey again to resend it; it will not pay twice.${moved}`;
    case 'unknown':
      return `A payment may have reached the seller (${out.refusal?.code}). Whether it settled is being checked; jaw_history shows it.${moved}`;
    default:
      if (out.payment) return `The signed payment expired unused. Nothing moved to the seller.${moved}`;
      if (oneOff) {
        return `Not paid: ${out.refusal?.code}. Nothing was sent. The owner can pay this once at ${oneOff.approveUrl}; poll jaw_request_status with that requestId.${raise}${moved}`;
      }
      return `Not paid: ${out.refusal?.code}. Nothing was sent.${raise}${moved}`;
  }
}

/** The answer for a row, from its columns, so a replay shows what the reconciler learned since. */
export function render(row: PaymentRow, fenced: string[], oneOff?: OneOffOffer): PayResult {
  const out = {
    paymentId: row.id,
    idempotencyKey: row.idempotencyKey,
    state: stateOf(row),
    kind: row.kind ?? 'failed',
    httpStatus: row.httpStatus,
    ...(row.nonce && {
      payment: {
        amount: row.amount ?? (row.authorized as string),
        asset: `${row.network}/erc20:${row.asset}`,
        authorized: row.authorized as string,
        payTo: row.payTo as string,
        nonce: row.nonce,
        ...(row.txHash && { txHash: row.txHash }),
        ...(row.blockTime && { blockTime: row.blockTime.toISOString() }),
      },
    }),
    ...(row.code && {
      refusal: {
        code: row.code,
        ...(RAISE.has(row.code) && { next: 'jaw_request_budget' as const }),
        ...(oneOff && { oneOff }),
      },
    }),
    ...(row.approvalId && { approvalId: row.approvalId }),
    ...((row.topUpAmount || row.topUpBatchId) && {
      topUp: { amount: row.topUpAmount ?? undefined, batchId: row.topUpBatchId ?? undefined },
    }),
    moneyMoved: Boolean(row.topUpAmount || row.topUpBatchId || row.approvalBatchId),
  };
  const structured = payOutput.parse({ ...out, summary: summaryOf(row, out) });
  return {
    content: [{ type: 'text', text: structured.summary }, ...fenced.map((text) => ({ type: 'text' as const, text }))],
    structuredContent: structured,
  };
}
