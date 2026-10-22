import type { ChainClients } from '@jaw.id/agent';
import { isAddressEqual, pad, parseAbi, parseEventLogs, zeroAddress, type Address, type Hex, type Log } from 'viem';
import { errorLabel, log } from '@/lib/edge';
import { ALLOWLIST } from './allowlist';
import type { SwapRow } from './store';

const fundsDeposited = parseAbi([
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
]);

export type DepositIdCode = 'receipt_missing' | 'deposit_not_found' | 'deposit_ambiguous';

const word = (address: Address) => pad(address.toLowerCase() as Hex);

// The hash can be a 4337 bundle holding other accounts' deposits, so the one matching log is taken.
export async function acrossDepositId(
  row: SwapRow,
  clients: ChainClients
): Promise<{ ok: true; depositId: string } | { ok: false; code: DepositIdCode }> {
  const across = ALLOWLIST[row.originChainId]?.across;
  const native = isAddressEqual(row.originToken as Address, zeroAddress);
  const inputToken = native ? across?.wrappedNative : (row.originToken as Address);
  if (!across || !inputToken) return { ok: false, code: 'deposit_not_found' };
  let logs: Log[];
  try {
    ({ logs } = await clients.publicClient(row.originChainId).getTransactionReceipt({ hash: row.txHash as Hex }));
  } catch (err) {
    log('warn', { msg: 'swap deposit receipt not read', swapId: row.id, error: errorLabel(err) });
    return { ok: false, code: 'receipt_missing' };
  }
  const ours = parseEventLogs({ abi: fundsDeposited, logs }).filter(
    ({ address, args }) =>
      isAddressEqual(address, across.spokePool) &&
      args.depositor === word(row.depositor as Address) &&
      args.inputToken === word(inputToken) &&
      args.inputAmount === BigInt(row.amount) &&
      args.destinationChainId === BigInt(row.destinationChainId)
  );
  if (ours.length === 0) return { ok: false, code: 'deposit_not_found' };
  if (ours.length > 1) return { ok: false, code: 'deposit_ambiguous' };
  return { ok: true, depositId: ours[0].args.depositId.toString() };
}
