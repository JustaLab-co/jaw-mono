import type { Address, Hex } from 'viem';
import { depositStatus, submitDeposit, type BackendAnswer, type BackendDeps } from './backend';
import { recordBackend, recordSubmit, type SwapRow } from './store';

export async function submit(row: SwapRow, deps?: BackendDeps): Promise<void> {
  const deposit = { depositAddress: row.depositAddress as Address, txHash: row.txHash as Hex };
  const answer = await submitDeposit(deposit, deps);
  const backendState = answer.ok && answer.status.state !== 'unknown' ? answer.status.backendState : undefined;
  await recordSubmit(row.connectionId, row.id, answer.ok, backendState);
}

export async function track(row: SwapRow, deps?: BackendDeps): Promise<BackendAnswer> {
  const read = await depositStatus(row.depositAddress as Address, deps);
  if (!read.ok || read.status.state === 'unknown') return read;
  await recordBackend(row.connectionId, row.id, read.status);
  if (read.status.state === 'pending_deposit' && row.state === 'deposit_sent' && row.txHash) {
    await submit(row, deps);
  }
  return read;
}
