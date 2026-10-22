import { encodeFunctionData, erc20Abi, getAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import type { BackendQuote, CheckCode, CheckResult, QuoteRequest, SwapCall } from '../check';

const baseUnits = /^[1-9][0-9]*$/;
const auroraQuoteId = /^aurora:(0x[0-9a-fA-F]{40})$/;

export async function checkAurora(
  request: QuoteRequest,
  quote: BackendQuote,
  isDepositAddressTaken: (depositAddress: Address) => Promise<boolean>
): Promise<CheckResult> {
  const fail = (code: CheckCode) => ({ ok: false as const, code });

  const id = auroraQuoteId.exec(quote.quoteId);
  if (!id || quote.deposit !== undefined) return fail('quote_id');
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
  const call: SwapCall = native
    ? { kind: 'deposit', chainId: request.originChainId, to: depositAddress, data: '0x', value: request.amount }
    : {
        kind: 'deposit',
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
    calls: [call],
    quote: {
      provider: 'aurora',
      inputAmount: quote.inputAmount,
      expectedOutputAmount,
      minOutputAmount,
      expectedFillTimeSec: quote.expectedFillTimeSec,
      ...(feesUsd !== undefined ? { feesUsd } : {}),
    },
  };
}
