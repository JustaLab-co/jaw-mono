import { isProxyChain } from '@/lib/chain';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { checkAurora } from './check/aurora';

export type Provider = 'aurora' | 'across' | 'relay';

export type QuoteRequest = {
  originChainId: number;
  originToken: Address;
  amount: string;
  account: Address;
  destinationChainId: number;
  destinationToken: string;
  recipient: string;
};

export type DepositCall = { chainId: number; to: Address; data: Hex; value: string };

export type SwapCall = { kind: 'approve' | 'deposit' } & DepositCall;

export type LegacyCall = { chainId: number; to: string; data: string; value: string };

export type CheckCode =
  | 'quote_invalid'
  | 'quote_id'
  | 'tx_count'
  | 'tx_chain'
  | 'tx_to'
  | 'tx_value'
  | 'tx_data'
  | 'input_amount'
  | 'output_amount'
  | 'deposit_address'
  | 'deposit_address_reused';

export type CheckedQuote = {
  ok: true;
  provider: Provider;
  quoteId: string;
  depositAddress?: Address;
  calls: SwapCall[];
  quote: {
    provider: Provider;
    inputAmount: string;
    expectedOutputAmount: string;
    minOutputAmount: string;
    expectedFillTimeSec: number;
    feesUsd?: string;
  };
};

export type CheckResult = CheckedQuote | { ok: false; code: CheckCode };

const usd = /^[0-9]+(\.[0-9]+)?$/;

const quoteShape = z.object({
  quoteId: z.string(),
  provider: z.string(),
  inputAmount: z.string(),
  expectedOutputAmount: z.string(),
  minOutputAmount: z.string(),
  expectedFillTimeSec: z.number().nonnegative(),
  fees: z.object({ totalUsd: z.string().regex(usd).optional().catch(undefined) }),
  transactions: z.array(z.object({ chainId: z.number(), to: z.string(), data: z.string(), value: z.string() })),
  deposit: z.unknown().optional(),
});

export type BackendQuote = z.infer<typeof quoteShape>;

export function isSupportedOriginChain(chainId: number): boolean {
  return isProxyChain(chainId);
}

export async function checkQuote(
  request: QuoteRequest,
  body: unknown,
  isDepositAddressTaken: (depositAddress: Address) => Promise<boolean>
): Promise<CheckResult> {
  const parsed = quoteShape.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'quote_invalid' };
  switch (parsed.data.provider) {
    case 'aurora':
      return checkAurora(request, parsed.data, isDepositAddressTaken);
    default:
      return { ok: false, code: 'quote_id' };
  }
}
