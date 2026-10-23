import type { ChainClients } from '@jaw.id/agent';
import type { Address, Hex } from 'viem';
import { proxyClientFor } from '@/lib/chain';
import { log } from '@/lib/edge';
import { acrossDepositId, type DepositIdCode } from './across-deposit';
import { depositStatus, submitDeposit, type BackendAnswer, type BackendDeps, type TrackKey } from './backend';
import {
  DEPOSIT_AMBIGUOUS,
  DEPOSIT_NOT_FOUND,
  DEPOSIT_REVERTED,
  providerOf,
  recordBackend,
  recordSentCode,
  recordSubmit,
  SEND_STARTED,
  type SwapRow,
  type SwapState,
} from './store';

export type TrackAnswer = BackendAnswer | { ok: false; code: DepositIdCode | 'hash_unknown' };

const liveClients: ChainClients = { publicClient: proxyClientFor };

const SENT: SwapState[] = ['deposit_sent', 'submitted'];

// Aurora and Relay keys come with the quote, so a deposit the wallet may have sent is read too.
// Across has no key until the deposit's hash is known.
function readable(row: SwapRow): boolean {
  switch (providerOf(row)) {
    case 'aurora':
      return true;
    case 'relay':
      return SENT.includes(row.state) || row.code === SEND_STARTED;
    case 'across':
      return SENT.includes(row.state);
  }
}

async function keyOf(
  row: SwapRow,
  clients: ChainClients
): Promise<{ ok: true; key: TrackKey } | Exclude<TrackAnswer, { ok: true }>> {
  switch (providerOf(row)) {
    case 'aurora':
      return { ok: true, key: { provider: 'aurora', depositAddress: row.depositAddress as Address } };
    case 'relay':
      return {
        ok: true,
        key: { provider: 'relay', requestId: row.quoteId!.slice('relay:'.length).toLowerCase() as Hex },
      };
    case 'across': {
      if (!row.txHash) return { ok: false, code: 'hash_unknown' };
      if (row.code === DEPOSIT_AMBIGUOUS || row.code === DEPOSIT_NOT_FOUND) return { ok: false, code: row.code };
      const found = await acrossDepositId(row, clients);
      if (!found.ok) {
        // A mined receipt does not change, so only a receipt not read yet is worth reading again.
        if (found.code !== 'receipt_missing') await recordSentCode(row.connectionId, row.id, found.code);
        return found;
      }
      return { ok: true, key: { provider: 'across', originChainId: row.originChainId, depositId: found.depositId } };
    }
  }
}

async function send(row: SwapRow, key: TrackKey, backend?: BackendDeps): Promise<void> {
  const answer = await submitDeposit(key, row.txHash as Hex, row.originChainId, backend);
  const backendState = answer.ok && answer.status.state !== 'unknown' ? answer.status.backendState : undefined;
  await recordSubmit(row.connectionId, row.id, answer.ok, backendState);
}

export async function submit(row: SwapRow, backend?: BackendDeps, clients = liveClients): Promise<void> {
  const key = await keyOf(row, clients);
  if (key.ok) await send(row, key.key, backend);
  else log('warn', { msg: 'swap deposit not submitted', swapId: row.id, code: key.code });
}

export async function track(
  row: SwapRow,
  backend?: BackendDeps,
  clients = liveClients
): Promise<TrackAnswer | undefined> {
  if (!readable(row)) return undefined;
  const key = await keyOf(row, clients);
  if (!key.ok) return key;
  const read = await depositStatus(key.key, backend);
  if (!read.ok || read.status.state === 'unknown') return read;
  await recordBackend(row.connectionId, row.id, read.status);
  // A reverted batch keeps its mined hash, but no deposit came from it.
  const resend =
    key.key.provider !== 'across' && row.state === 'deposit_sent' && row.txHash && row.code !== DEPOSIT_REVERTED;
  if (read.status.state === 'pending_deposit' && resend) await send(row, key.key, backend);
  return read;
}
