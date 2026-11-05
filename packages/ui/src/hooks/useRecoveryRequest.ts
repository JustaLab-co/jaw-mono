'use client';

import { useEffect, useState } from 'react';
import { getCeremony, type Ceremony } from '@jaw.id/core';
import type { Hex } from 'viem';
import { isRecoveryRequestSettled } from '../utils/recoveryRequest';

/** How often an open recovery request is read again while its status is on screen. */
export const RECOVERY_REQUEST_POLL_MS = 5_000;

export interface UseRecoveryRequestResult {
  /** The request as the backend holds it; null until the first read lands. */
  ceremony: Ceremony | null;
  /** The last read failed. The last known state stays on screen and the next tick reads again. */
  failed: boolean;
  /** Every network reached an end: nothing is polled any more. */
  settled: boolean;
}

/**
 * Follows a recovery request (`getCeremony`) while its status is on screen: read at once, then
 * every five seconds until no network can move. Guardians approve while the user waits on the
 * call, so their approvals appear as they land.
 *
 * The twin of `useRecoveryRelayStatus` for a request, with no time limit: a request stays open
 * for days, and the screen polls only while it is open.
 *
 * @param requestId - The request to follow; nothing is read without one
 */
export function useRecoveryRequest(requestId: Hex | null | undefined, apiKey?: string): UseRecoveryRequestResult {
  const [ceremony, setCeremony] = useState<Ceremony | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCeremony(null);
    setFailed(false);
    if (!requestId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const fresh = await getCeremony(requestId, apiKey);
        if (cancelled) return;
        setCeremony(fresh);
        setFailed(false);
        if (isRecoveryRequestSettled(fresh)) return;
      } catch {
        if (cancelled) return;
        setFailed(true);
      }
      timer = setTimeout(poll, RECOVERY_REQUEST_POLL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [requestId, apiKey]);

  return { ceremony, failed, settled: !!ceremony && isRecoveryRequestSettled(ceremony) };
}
