import type { Address } from 'viem';
import type { Wallet } from '@/connections/relay';
import { resumeRow, resumeTick, waitingIn, type Rejoin } from '@/connections/resume';
import { followOwner } from '@/owner-calls/follow';
import { approve } from './approve';
import type { BackendDeps } from './backend';
import { leasedSwaps, type SwapRow } from './store';

export type SwapRunDeps = { pollMs?: number; backend?: BackendDeps };

export const followSwap = (account: Address, row: SwapRow, wallet: Wallet, deps: SwapRunDeps, resumed = false) =>
  followOwner(
    leasedSwaps,
    row,
    wallet,
    (ask) => approve(ask, row, account, deps.pollMs, deps.backend),
    'swapId',
    resumed
  );

const rejoin = (deps: SwapRunDeps): Rejoin<SwapRow> => ({
  idField: 'swapId',
  take: leasedSwaps.take,
  release: leasedSwaps.release,
  failed: leasedSwaps.failed,
  lost: leasedSwaps.end,
  start: (row, t) => (wallet) => followSwap(t.account, row, wallet, deps, true),
});

export const swapsWaiting = (deps: SwapRunDeps = {}) => waitingIn(leasedSwaps.toResume, rejoin(deps));

export const resumeSwaps = (deps?: SwapRunDeps) => resumeTick([swapsWaiting(deps)]);

export const resumeSwap = (row: SwapRow, deps: SwapRunDeps = {}) => resumeRow(row, rejoin(deps));
