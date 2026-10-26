import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { parseCalls } from './calls';

export type Provider = 'aurora' | 'across' | 'relay';

export type DepositCall = { chainId: number; to: Address; data: Hex; value: string };

export type SwapCall = { kind: 'approve' | 'deposit' } & DepositCall;

export type CheckCode =
  | 'quote_invalid'
  | 'quote_unsupported_provider'
  | 'quote_id'
  | 'tx_calls'
  | 'tx_chain'
  | 'input_amount'
  | 'approve_token'
  | 'approve_spender'
  | 'order_too_large';

export type QuoteRequest = { originChainId: number; originToken: string; amount: string };

export type CheckedQuote = {
  ok: true;
  quoteId: string;
  calls: SwapCall[];
  quote: {
    provider: Provider;
    inputAmount: string;
    expectedOutputAmount: string;
    minOutputAmount: string;
    expectedFillTimeSec: number;
    feesUsd?: string;
    orderData?: Record<string, unknown>;
  };
};

export type CheckResult = CheckedQuote | { ok: false; code: CheckCode };

export const QUOTE_ID = /^(aurora:0x[0-9a-fA-F]{40}|across:[A-Za-z0-9-]{1,64}|relay:0x[0-9a-fA-F]{64})$/;

// Aurora rows from before stay readable through Provider and QUOTE_ID; new quotes are Across or Relay.
const PROVIDERS: ReadonlySet<string> = new Set<Provider>(['across', 'relay']);

const usd = /^[0-9]+(\.[0-9]+)?$/;
const MAX_ORDER_CHARS = 32_768;

const quoteShape = z.object({
  quoteId: z.string(),
  provider: z.string(),
  inputAmount: z.string(),
  expectedOutputAmount: z.string(),
  minOutputAmount: z.string(),
  expectedFillTimeSec: z.number().nonnegative(),
  fees: z.object({ totalUsd: z.string().regex(usd).optional().catch(undefined) }),
  transactions: z.array(z.object({ chainId: z.number(), to: z.string(), data: z.string(), value: z.string() })),
  relayOrder: z
    .object({ orderData: z.record(z.string(), z.unknown()) })
    .optional()
    .catch(undefined),
});

export function checkQuote(request: QuoteRequest, body: unknown): CheckResult {
  const fail = (code: CheckCode) => ({ ok: false as const, code });
  const parsed = quoteShape.safeParse(body);
  if (!parsed.success) return fail('quote_invalid');
  const quote = parsed.data;
  if (!PROVIDERS.has(quote.provider)) return fail('quote_unsupported_provider');
  const provider = quote.provider as Provider;
  if (!QUOTE_ID.test(quote.quoteId) || !quote.quoteId.startsWith(`${provider}:`)) return fail('quote_id');

  const last = quote.transactions.length - 1;
  const calls = parseCalls(
    quote.transactions.map(({ chainId, to, data, value }, i) => ({
      kind: i === last ? 'deposit' : 'approve',
      chainId,
      to,
      data,
      value,
    }))
  );
  if (!calls) return fail('tx_calls');
  if (calls[0].chainId !== request.originChainId) return fail('tx_chain');
  if (quote.inputAmount !== request.amount) return fail('input_amount');
  if (calls.length === 2) {
    const [approve, deposit] = calls;
    // approve(spender, amount): the spender is the low 20 bytes of the first argument.
    const spender = `0x${approve.data.slice(34, 74)}`;
    if (approve.to.toLowerCase() !== request.originToken.toLowerCase()) return fail('approve_token');
    if (spender.toLowerCase() !== deposit.to.toLowerCase()) return fail('approve_spender');
  }
  const orderData = provider === 'relay' ? quote.relayOrder?.orderData : undefined;
  if (orderData && JSON.stringify(orderData).length > MAX_ORDER_CHARS) return fail('order_too_large');

  const feesUsd = quote.fees.totalUsd;
  return {
    ok: true,
    quoteId: quote.quoteId,
    calls,
    quote: {
      provider,
      inputAmount: quote.inputAmount,
      expectedOutputAmount: quote.expectedOutputAmount,
      minOutputAmount: quote.minOutputAmount,
      expectedFillTimeSec: quote.expectedFillTimeSec,
      ...(feesUsd !== undefined ? { feesUsd } : {}),
      ...(orderData && { orderData }),
    },
  };
}
