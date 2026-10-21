import type { ChainClients } from '@jaw.id/agent';
import { chainClients } from '@/adapters/session-host';
import type { Wallet } from '@/connections/relay';
import { resumeRow, resumeTick, waitingIn, type Rejoin } from '@/connections/resume';
import { approve } from './approve';
import { followOwner } from './follow';
import { leasedCalls, type OwnerCallRow } from './store';

export const followCalls = (row: OwnerCallRow, wallet: Wallet, clients: ChainClients, resumed = false) =>
  followOwner(leasedCalls, row, wallet, (ask) => approve(ask, row, clients), 'ownerCallId', resumed);

const rejoin = (clients: ChainClients): Rejoin<OwnerCallRow> => ({
  idField: 'ownerCallId',
  take: leasedCalls.take,
  release: leasedCalls.release,
  failed: leasedCalls.failed,
  lost: leasedCalls.end,
  start: (row) => (wallet) => followCalls(row, wallet, clients, true),
});

export const callsWaiting = (clients: ChainClients = chainClients) => waitingIn(leasedCalls.toResume, rejoin(clients));

export const resumeOwnerCalls = (clients?: ChainClients) => resumeTick([callsWaiting(clients)]);

export const resumeCall = (row: OwnerCallRow, clients: ChainClients = chainClients) => resumeRow(row, rejoin(clients));
