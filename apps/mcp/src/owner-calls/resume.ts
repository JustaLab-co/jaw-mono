import type { ChainClients } from '@jaw.id/agent';
import { chainClients } from '@/adapters/session-host';
import type { Wallet } from '@/connections/relay';
import { resumeEach, resumeRow, RESUMES_PER_TICK, type Rejoin } from '@/connections/resume';
import { approve } from './approve';
import { followOwner } from './follow';
import { leasedCalls, type OwnerCallRow } from './store';

export const followCalls = (row: OwnerCallRow, wallet: Wallet, clients: ChainClients) =>
  followOwner(leasedCalls, row, wallet, (ask) => approve(ask, row, clients), 'ownerCallId');

const rejoin = (clients: ChainClients): Rejoin<OwnerCallRow> => ({
  idField: 'ownerCallId',
  take: leasedCalls.take,
  release: leasedCalls.release,
  lost: leasedCalls.end,
  start: (row) => (wallet) => followCalls(row, wallet, clients),
});

export const resumeOwnerCalls = (clients: ChainClients = chainClients) =>
  resumeEach(() => leasedCalls.toResume(RESUMES_PER_TICK), rejoin(clients));

export const resumeCall = (row: OwnerCallRow, clients: ChainClients) => resumeRow(row, rejoin(clients));
