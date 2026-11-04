'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Account, RecoveryNetworksPlan } from '@jaw.id/core';
import type { RecoverySetupProblem } from '../utils/recoverySetup';

export interface UseRecoveryNetworksOptions {
  /** The account signing the change: its key decides which networks it can change. */
  account?: Pick<Account, 'getRecoveryNetworks'> | null;
  enabled?: boolean;
}

export interface UseRecoveryNetworksResult {
  /** Where a change goes and why the other networks don't take it, once it lands. */
  plan: RecoveryNetworksPlan | null;
  loading: boolean;
  /** A named reason the read can't be used, or null. */
  problem: RecoverySetupProblem | null;
  /** Read again, after a transaction changed what the networks hold. Resolves to the fresh plan. */
  reload: () => Promise<RecoveryNetworksPlan | null>;
}

/**
 * Reads where a recovery change would go: the same read `Account.setupRecovery` makes before it
 * signs, so the screen shows the networks the signature will reach.
 *
 * The twin of `usePermissionRevocation` for recovery, kept as a hook for the same reason: the SDK's
 * own handler (AppSpecific) and the keys popup (CrossPlatform) both need it, and one hook keeps
 * them reading the chains the same way.
 */
export function useRecoveryNetworks({
  account,
  enabled = true,
}: UseRecoveryNetworksOptions): UseRecoveryNetworksResult {
  const [plan, setPlan] = useState<RecoveryNetworksPlan | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPlan(null);
    setFailed(false);
    if (!enabled || !account) return;

    let cancelled = false;
    account
      .getRecoveryNetworks()
      .then((fresh) => {
        if (!cancelled) setPlan(fresh);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [account, enabled]);

  const reload = useCallback(async () => {
    if (!account) return null;
    try {
      const fresh = await account.getRecoveryNetworks();
      setPlan(fresh);
      setFailed(false);
      return fresh;
    } catch {
      setFailed(true);
      return null;
    }
  }, [account]);

  if (!enabled) return { plan: null, loading: false, problem: null, reload };
  if (failed) return { plan: null, loading: false, problem: 'lookup-failed', reload };
  // Derived, not stored: a `loading` initialised to false would report "no problem" for the first
  // render, briefly enabling Continue on an account nothing is known about yet.
  if (!plan) return { plan: null, loading: true, problem: null, reload };
  return { plan, loading: false, problem: null, reload };
}
