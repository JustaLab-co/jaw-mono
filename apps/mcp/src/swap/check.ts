import { getSupportedChains } from '@jaw.id/core';
import { encodeFunctionData, erc20Abi, getAddress, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

export type QuoteRequest = { originChainId: number; originToken: Address; amount: string; account: Address };

export type DepositCall = { chainId: number; to: Address; data: Hex; value: string };

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
  quoteId: string;
  depositAddress: Address;
  call: DepositCall;
  quote: {
    inputAmount: string;
    expectedOutputAmount: string;
    minOutputAmount: string;
    expectedFillTimeSec: number;
    feesUsd?: string;
  };
};

const baseUnits = /^[1-9][0-9]*$/;
const usd = /^[0-9]+(\.[0-9]+)?$/;
const auroraQuoteId = /^aurora:(0x[0-9a-fA-F]{40})$/;

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

export function isSupportedOriginChain(chainId: number): boolean {
  return getSupportedChains(true).some((chain) => chain.id === chainId);
}

export async function checkQuote(
  request: QuoteRequest,
  body: unknown,
  isDepositAddressTaken: (depositAddress: Address) => Promise<boolean>
): Promise<CheckedQuote | { ok: false; code: CheckCode }> {
  const fail = (code: CheckCode) => ({ ok: false as const, code });
  const parsed = quoteShape.safeParse(body);
  if (!parsed.success) return fail('quote_invalid');
  const quote = parsed.data;

  const id = auroraQuoteId.exec(quote.quoteId);
  if (!id || quote.provider !== 'aurora' || quote.deposit !== undefined) return fail('quote_id');
  const depositAddress = getAddress(id[1]);

  if (quote.transactions.length !== 1) return fail('tx_count');
  const [tx] = quote.transactions;
  if (tx.chainId !== request.originChainId) return fail('tx_chain');

  if (!baseUnits.test(request.amount) || quote.inputAmount !== request.amount) return fail('input_amount');
  const { expectedOutputAmount, minOutputAmount } = quote;
  if (!baseUnits.test(expectedOutputAmount) || !baseUnits.test(minOutputAmount)) return fail('output_amount');
  if (BigInt(minOutputAmount) > BigInt(expectedOutputAmount)) return fail('output_amount');

  if ([request.account, request.originToken, zeroAddress].some((a) => isAddressEqual(a, depositAddress))) {
    return fail('deposit_address');
  }

  const native = isAddressEqual(request.originToken, zeroAddress);
  const call: DepositCall = native
    ? { chainId: request.originChainId, to: depositAddress, data: '0x', value: request.amount }
    : {
        chainId: request.originChainId,
        to: getAddress(request.originToken),
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [depositAddress, BigInt(request.amount)],
        }),
        value: '0',
      };
  if (tx.to.toLowerCase() !== call.to.toLowerCase()) return fail('tx_to');
  if (tx.value !== call.value) return fail('tx_value');
  if (tx.data.toLowerCase() !== call.data) return fail('tx_data');

  if (await isDepositAddressTaken(depositAddress)) return fail('deposit_address_reused');

  const feesUsd = quote.fees.totalUsd;
  return {
    ok: true,
    quoteId: `aurora:${depositAddress}`,
    depositAddress,
    call,
    quote: {
      inputAmount: quote.inputAmount,
      expectedOutputAmount,
      minOutputAmount,
      expectedFillTimeSec: quote.expectedFillTimeSec,
      ...(feesUsd !== undefined ? { feesUsd } : {}),
    },
  };
}
