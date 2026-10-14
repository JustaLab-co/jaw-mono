import { getAddress, isAddress, type Address } from 'viem';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { pay, type PayDeps } from '@/payments/pay';
import { gateCode, rawBody, resent, type PayResult } from '@/payments/render';
import { findPayment } from '@/payments/store';
import { checkQuote, type QuoteRequest } from './check';
import {
  depositAddressReused,
  isDepositAddressTaken,
  nextAttempt,
  release,
  writeHeld,
  type SwapLease,
  type SwapRequest,
  type SwapRow,
} from './store';

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
  const lease = { connectionId: t.connectionId, id: held.row.id, token: held.token };
  const request = quoteRequestOf(held.row);
  if (!request) return stepOf(await writeHeld(lease, { state: 'quote_failed', code: 'invalid_request' }));
  const row = (await nextAttempt(lease)) ?? held.row;
  const payment = await pay(t, { url: quoteUrl(row), maxAmount: QUOTE_PRICE, idempotencyKey: row.paymentKey }, deps, {
    keepBody: true,
  });
  return stepOf(await conclude(lease, request, payment), payment);
}

const stepOf = (row: SwapRow | undefined, payment?: PayResult): QuoteStep =>
  row ? { kind: 'done', row, payment } : { kind: 'lease_lost' };

function quoteRequestOf(row: SwapRow): QuoteRequest | undefined {
  if (!isAddress(row.originToken, { strict: false }) || !isAddress(row.depositor, { strict: false })) return undefined;
  return {
    originChainId: row.originChainId,
    originToken: getAddress(row.originToken),
    amount: row.amount,
    account: getAddress(row.depositor),
  };
}

async function conclude(lease: SwapLease, request: QuoteRequest, payment: PayResult): Promise<SwapRow | undefined> {
  const out = payment.structuredContent;
  if (!out) return release(lease, { code: payment[gateCode] });
  const raw = payment[rawBody];
  if (out.kind === 'paid' && out.httpStatus === 200 && raw !== undefined) return keepQuote(lease, request, out, raw);
  const final = finalCodeOf(out, payment[resent] === true);
  if (final) return finalWrite(lease, out, 'quote_failed', final);
  const code = out.kind === 'free' ? 'backend_unavailable' : (out.refusal?.code ?? null);
  return release(lease, { code, paymentId: out.paymentId });
}

const UNRETRYABLE_REFUSALS = new Map([
  ['network_mismatch', 'wrong_chain'],
  ['insecure_url', 'insecure_url'],
]);

function finalCodeOf(out: Paid, afterResend: boolean): string | undefined {
  const unretryable = out.refusal && UNRETRYABLE_REFUSALS.get(out.refusal.code);
  if (unretryable) return unretryable;
  if (out.kind === 'free') return (out.httpStatus ?? 0) >= 500 ? undefined : 'quote_unavailable';
  if (out.kind === 'paid') return 'quote_invalid';
  if (out.kind !== 'failed' || out.state !== 'unknown') return undefined;
  if (out.httpStatus !== 402) return 'quote_invalid';
  return afterResend ? 'quote_lost' : undefined;
}

async function keepQuote(lease: SwapLease, request: QuoteRequest, out: Paid, raw: string) {
  const checked = await checkQuote(request, dataOf(raw), isDepositAddressTaken);
  if (!checked.ok) {
    const state = checked.code === 'quote_invalid' ? 'quote_failed' : 'quote_rejected';
    return finalWrite(lease, out, state, checked.code);
  }
  const paid = await findPayment(out.paymentId);
  try {
    return await writeHeld(lease, {
      code: null,
      paymentId: out.paymentId,
      paidAt: paid?.signedAt,
      quoteId: checked.quoteId,
      depositAddress: checked.depositAddress,
      quote: checked.quote,
      call: checked.call,
      quoteFenced: fencedOf(out),
    });
  } catch (err) {
    if (!depositAddressReused(err)) throw err;
    return finalWrite(lease, out, 'quote_rejected', 'deposit_address_reused');
  }
}

const finalWrite = (lease: SwapLease, out: Paid, state: 'quote_failed' | 'quote_rejected', code: string) =>
  writeHeld(lease, { state, code, paymentId: out.paymentId, quoteFenced: fencedOf(out) });

const fencedOf = (out: Paid) => out.response?.join('\n');

function dataOf(raw: string): unknown {
  try {
    return JSON.parse(raw)?.result?.data;
  } catch {
    return undefined;
  }
}
