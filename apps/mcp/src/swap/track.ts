import type { ChainClients } from '@jaw.id/agent';
import type { Address, Hex } from 'viem';
import { proxyClientFor } from '@/lib/chain';
import { log } from '@/lib/edge';
import { acrossDepositId, type DepositIdCode } from './across-deposit';
import {
  depositStatus,
  submitDeposit,
  type BackendAnswer,
  type BackendDeps,
  type BackendState,
  type TrackKey,
} from './backend';
import type { Provider } from './check';
import { DEPOSIT_REVERTED, recordBackend, recordSubmit, type SwapRow, type SwapState } from './store';

export type TrackAnswer = BackendAnswer | { ok: false; code: DepositIdCode | 'hash_unknown' };

const liveClients: ChainClients = { publicClient: proxyClientFor };

const SENT: SwapState[] = ['deposit_sent', 'submitted'];

// The backend answers a submit for a hash Across or Relay have not seen with PENDING_DEPOSIT.
const PROVING = new Set<BackendState>(['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED']);

const providerOf = (row: SwapRow): Provider => (row.quote as { provider?: Provider } | null)?.provider ?? 'aurora';

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
      const found = await acrossDepositId(row, clients);
      if (!found.ok) return found;
      return { ok: true, key: { provider: 'across', originChainId: row.originChainId, depositId: found.depositId } };
    }
  }
}

function ownHash(row: SwapRow, key: TrackKey, answer: BackendAnswer): BackendAnswer {
  if (key.provider === 'aurora' || !answer.ok || !row.txHash || !answer.status.txHash) return answer;
  if (answer.status.txHash.toLowerCase() === row.txHash.toLowerCase()) return answer;
  log('warn', { msg: 'swap backend answered another deposit hash', swapId: row.id, provider: key.provider });
  return { ok: false, code: 'invalid_response' };
}

async function send(row: SwapRow, key: TrackKey, backend?: BackendDeps): Promise<void> {
  const answer = ownHash(row, key, await submitDeposit(key, row.txHash as Hex, row.originChainId, backend));
  const backendState = answer.ok && answer.status.state !== 'unknown' ? answer.status.backendState : undefined;
  const accepted = key.provider === 'aurora' ? answer.ok : backendState !== undefined && PROVING.has(backendState);
  await recordSubmit(row.connectionId, row.id, accepted, backendState);
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
  if (providerOf(row) !== 'aurora' && !SENT.includes(row.state)) return undefined;
  const key = await keyOf(row, clients);
  if (!key.ok) return key;
  const read = ownHash(row, key.key, await depositStatus(key.key, backend));
  if (!read.ok || read.status.state === 'unknown') return read;
  await recordBackend(row.connectionId, row.id, read.status);
  // A reverted batch keeps its mined hash, but no deposit came from it.
  const reverted = row.code === DEPOSIT_REVERTED;
  if (read.status.state === 'pending_deposit' && row.state === 'deposit_sent' && row.txHash && !reverted) {
    await send(row, key.key, backend);
  }
  return read;
}
