import type { Address } from 'viem';
import type { Wallet } from '@/connections/relay';
import { resumeEach, resumeRow, RESUMES_PER_TICK, type Rejoin } from '@/connections/resume';
import { followOwner } from '@/owner-calls/follow';
import { approve } from './approve';
import type { BackendDeps } from './backend';
import { leasedSwaps, type SwapRow } from './store';

export type SwapRunDeps = { pollMs?: number; backend?: BackendDeps };

export const followSwap = (account: Address, row: SwapRow, wallet: Wallet, deps: SwapRunDeps) =>
  followOwner(leasedSwaps, row, wallet, (ask) => approve(ask, row, account, deps.pollMs, deps.backend), 'swapId');

const rejoin = (deps: SwapRunDeps): Rejoin<SwapRow> => ({
  idField: 'swapId',
  take: leasedSwaps.take,
  release: leasedSwaps.release,
  lost: leasedSwaps.end,
  start: (row, t) => (wallet) => followSwap(t.account, row, wallet, deps),
});

export const resumeSwaps = (deps: SwapRunDeps = {}) =>
  resumeEach(() => leasedSwaps.toResume(RESUMES_PER_TICK), rejoin(deps));

export const resumeSwap = (row: SwapRow, deps: SwapRunDeps) => resumeRow(row, rejoin(deps));
