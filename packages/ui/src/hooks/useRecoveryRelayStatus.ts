'use client';

import { useEffect, useState } from 'react';
import { getAdminBatch, type AdminBatchChain } from '@jaw.id/core';
import type { Hex } from 'viem';
import { recoveryRelayState } from '../utils/recoverySetup';

/** How often a relayed change is polled, and for how long before the screen stops waiting. */
export const RECOVERY_RELAY_POLL_MS = 3_000;
export const RECOVERY_RELAY_POLL_TIMEOUT_MS = 300_000;

export interface UseRecoveryRelayStatusResult {
  /** The latest status per network: the starting statuses until the first poll lands. */
  chains: AdminBatchChain[];
  /** No network is in flight any more. */
  settled: boolean;
  /** Stopped polling with a network still in flight; the relayer carries on in the background. */
  timedOut: boolean;
}

/**
 * Polls a relayed admin batch (`getAdminBatch`) until no network is in flight, or for five minutes.
 * The batch has no status of its own: it is done when every network's job is.
 *
 * @param batchId - The batch to poll; nothing is polled without one (the account door has none)
 * @param initial - The statuses the submit answered with, shown until the first poll lands
 */
export function useRecoveryRelayStatus(
  batchId: Hex | undefined,
  initial: AdminBatchChain[],
  apiKey?: string
): UseRecoveryRelayStatusResult {
  const [chains, setChains] = useState(initial);
  const [timedOut, setTimedOut] = useState(false);

  const inFlight = (list: AdminBatchChain[]) => list.some((chain) => recoveryRelayState(chain.status) === 'updating');
  const settled = !inFlight(chains);

  useEffect(() => {
    setChains(initial);
    setTimedOut(false);
    if (!batchId || !inFlight(initial)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const poll = async () => {
      try {
        const batch = await getAdminBatch(batchId, apiKey);
        if (cancelled) return;
        setChains(batch.chains);
        if (!inFlight(batch.chains)) return;
      } catch {
        // A failed poll is retried on the next tick; the last known statuses stay on screen.
        if (cancelled) return;
      }
      if (Date.now() - startedAt >= RECOVERY_RELAY_POLL_TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(poll, RECOVERY_RELAY_POLL_MS);
    };
    timer = setTimeout(poll, RECOVERY_RELAY_POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `initial` is the submit's answer for this batch: it changes only with the batch id.
  }, [batchId, apiKey]);

  return { chains, settled, timedOut };
}
