import { isProxyChain } from '@/lib/chain';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { checkAcross } from './check/across';
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
  | 'unsupported_chain'
  | 'tx_count'
  | 'tx_chain'
  | 'tx_to'
  | 'tx_value'
  | 'tx_data'
  | 'tx_selector'
  | 'approve_spender'
  | 'input_amount'
  | 'output_amount'
  | 'output_floor'
  | 'output_token'
  | 'recipient'
  | 'depositor'
  | 'destination_chain'
  | 'message_program'
  | 'app_fee'
  | 'deadline'
  | 'exclusivity'
  | 'route_unsupported'
  | 'order_missing'
  | 'order_id'
  | 'order_terms'
  | 'order_calls'
  | 'refund_recipient'
  | 'refund_terms'
  | 'deposit_address'
  | 'deposit_address_reused';

export type CheckedQuote = {
  ok: true;
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
    deadline?: number;
    appFee?: string;
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
  relayOrder: z.unknown().optional(),
});

export type BackendQuote = z.infer<typeof quoteShape>;

export function isSupportedOriginChain(chainId: number): boolean {
  return isProxyChain(chainId);
}

export type CheckDeps = {
  isDepositAddressTaken: (depositAddress: Address) => Promise<boolean>;
  now: () => number;
  ownerWindowSec: number;
};

export async function checkQuote(request: QuoteRequest, body: unknown, deps: CheckDeps): Promise<CheckResult> {
  const parsed = quoteShape.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'quote_invalid' };
  switch (parsed.data.provider) {
    case 'aurora':
      return checkAurora(request, parsed.data, deps.isDepositAddressTaken);
    case 'across':
      return checkAcross(request, parsed.data, deps.now(), deps.ownerWindowSec);
    default:
      return { ok: false, code: 'quote_id' };
  }
}
