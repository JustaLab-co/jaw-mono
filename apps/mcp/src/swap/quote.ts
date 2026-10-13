import { getAddress, type Address } from 'viem';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { pay, type PayDeps } from '@/payments/pay';
import { gateCode, rawBody, type PayResult } from '@/payments/render';
import { findPayment } from '@/payments/store';
import { checkQuote } from './check';
import { isDepositAddressTaken, nextAttempt, release, writeHeld, type SwapRequest, type SwapRow } from './store';

const QUOTE_PRICE = '5000';

export type SwapInput = {
  originChainId: number;
  originToken: Address;
  destinationChainId: number;
  destinationToken: string;
  amount: string;
  recipient?: string;
};

export type QuoteStep = { kind: 'done'; row: SwapRow; payment?: PayResult } | { kind: 'lease_lost' };

type Paid = NonNullable<PayResult['structuredContent']>;

const lowerHex = (value: string) => (/^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value);

export function swapRequest(t: Tenant, input: SwapInput): SwapRequest {
  return {
    originChainId: input.originChainId,
    originToken: lowerHex(input.originToken),
    destinationChainId: input.destinationChainId,
    destinationToken: lowerHex(input.destinationToken),
    amount: input.amount,
    depositor: lowerHex(t.account),
    recipient: lowerHex(input.recipient ?? t.account),
  };
}

function quoteUrl(row: SwapRow): string {
  const query = new URLSearchParams({
    originChainId: String(row.originChainId),
    destinationChainId: String(row.destinationChainId),
    originToken: row.originToken,
    destinationToken: row.destinationToken,
    amount: row.amount,
    depositor: row.depositor,
    recipient: row.recipient,
    tradeType: 'EXACT_INPUT',
  });
  return `${config().swapUrl}/swap/quote?${query}`;
}

export async function quote(t: Tenant, held: { row: SwapRow; token: string }, deps?: PayDeps): Promise<QuoteStep> {
  if (held.row.quoteId) return { kind: 'done', row: held.row };
  const { token } = held;
  const row = (await nextAttempt(held.row.id, token)) ?? held.row;
  const payment = await pay(
    t,
    {
      url: quoteUrl(row),
      headers: { 'Idempotency-Key': `swap:${row.id}` },
      maxAmount: QUOTE_PRICE,
      idempotencyKey: row.paymentKey,
    },
    deps,
    { keepBody: true }
  );
  const written = await conclude(row, token, payment);
  return written ? { kind: 'done', row: written, payment } : { kind: 'lease_lost' };
}

async function conclude(row: SwapRow, token: string, payment: PayResult): Promise<SwapRow | undefined> {
  const out = payment.structuredContent;
  if (!out) return release(row.id, token, { code: payment[gateCode] });
  const raw = payment[rawBody];
  if (out.kind === 'paid' && out.httpStatus === 200 && raw !== undefined) return keepQuote(row, token, out, raw);
  const final = finalCodeOf(out);
  if (final) return finalWrite(row, token, out, 'quote_failed', final);
  return release(row.id, token, { code: out.refusal?.code ?? null, paymentId: out.paymentId });
}

function finalCodeOf(out: Paid): string | undefined {
  if (out.refusal?.code === 'network_mismatch') return 'wrong_chain';
  if (out.kind === 'free') return 'quote_unavailable';
  if (out.kind === 'paid') return 'quote_invalid';
  if (out.kind !== 'failed' || out.state !== 'unknown') return undefined;
  const proofAlreadySpent = out.httpStatus === 402;
  return proofAlreadySpent ? 'quote_lost' : 'quote_invalid';
}

async function keepQuote(row: SwapRow, token: string, out: Paid, raw: string): Promise<SwapRow | undefined> {
  const request = {
    originChainId: row.originChainId,
    originToken: getAddress(row.originToken),
    amount: row.amount,
    account: getAddress(row.depositor),
  };
  const checked = await checkQuote(request, dataOf(raw), isDepositAddressTaken);
  if (!checked.ok) {
    const state = checked.code === 'quote_invalid' ? 'quote_failed' : 'quote_rejected';
    return finalWrite(row, token, out, state, checked.code);
  }
  const paid = await findPayment(out.paymentId);
  return writeHeld(row.id, token, {
    code: null,
    paymentId: out.paymentId,
    paidAt: paid?.signedAt,
    quoteId: checked.quoteId,
    depositAddress: checked.depositAddress,
    quote: checked.quote,
    call: checked.call,
    quoteFenced: fencedOf(out),
  });
}

const finalWrite = (row: SwapRow, token: string, out: Paid, state: 'quote_failed' | 'quote_rejected', code: string) =>
  writeHeld(row.id, token, { state, code, paymentId: out.paymentId, quoteFenced: fencedOf(out) });

const fencedOf = (out: Paid) => out.response?.join('\n');

function dataOf(raw: string): unknown {
  try {
    return JSON.parse(raw)?.result?.data;
  } catch {
    return undefined;
  }
}
