import type { ChainClients } from '@jaw.id/agent';
import { pad, parseAbi, parseEventLogs, type Address, type Hex, type Log } from 'viem';
import { errorLabel, log } from '@/lib/edge';
import type { SwapRow } from './store';

const fundsDeposited = parseAbi([
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
]);

export type DepositIdCode = 'receipt_missing' | 'deposit_not_found' | 'deposit_ambiguous';

// The hash can be a 4337 bundle holding other accounts' deposits, so the one log from this
// account to this destination is taken. A swap before the bridge deposits another token than
// the one the account sent, so the token and amount are not compared.
export async function acrossDepositId(
  row: SwapRow,
  clients: ChainClients
): Promise<{ ok: true; depositId: string } | { ok: false; code: DepositIdCode }> {
  let logs: Log[];
  try {
    ({ logs } = await clients.publicClient(row.originChainId).getTransactionReceipt({ hash: row.txHash as Hex }));
  } catch (err) {
    log('warn', { msg: 'swap deposit receipt not read', swapId: row.id, error: errorLabel(err) });
    return { ok: false, code: 'receipt_missing' };
  }
  const depositor = pad(row.depositor.toLowerCase() as Address);
  const ours = parseEventLogs({ abi: fundsDeposited, logs }).filter(
    ({ args }) => args.depositor === depositor && args.destinationChainId === BigInt(row.destinationChainId)
  );
  if (ours.length === 0) return { ok: false, code: 'deposit_not_found' };
  if (ours.length > 1) return { ok: false, code: 'deposit_ambiguous' };
  return { ok: true, depositId: ours[0].args.depositId.toString() };
}
