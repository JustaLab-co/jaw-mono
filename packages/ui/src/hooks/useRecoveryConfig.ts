'use client';

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { getRecoveryConfig, type RecoveryChainConfig } from '@jaw.id/core';
import type { RecoverySetupProblem } from '../utils/recoverySetup';

export interface UseRecoveryConfigOptions {
  /** The account whose recovery is being set up: the request's own address. */
  address?: Address;
  apiKey?: string;
  /** The connected chain, where a first setup lands and an edit is planned. */
  chainId?: number;
  enabled?: boolean;
}

export interface UseRecoveryConfigResult {
  /** The account's recovery config on the connected chain, once it lands. */
  config: RecoveryChainConfig | null;
  /** The config on every recovery-supported chain: an edit reaches the enrolled ones. */
  chains: RecoveryChainConfig[];
  loading: boolean;
  /** A named reason the config can't be used, or null. */
  problem: RecoverySetupProblem | null;
}

/**
 * Reads the account's recovery config: the state a setup or an edit is built against, the same
 * read `Account.setupRecovery` makes before it picks a door.
 *
 * The twin of `usePermissionRevocation` for recovery, kept as a hook for the same reason: the SDK's
 * own handler (AppSpecific) and the keys popup (CrossPlatform) both need it, and one hook keeps
 * them reading the same chain the same way.
 */
export function useRecoveryConfig({
  address,
  apiKey,
  chainId,
  enabled = true,
}: UseRecoveryConfigOptions): UseRecoveryConfigResult {
  const [chains, setChains] = useState<RecoveryChainConfig[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setChains(null);
    setFailed(false);
    if (!enabled || !address || !chainId) return;

    let cancelled = false;
    getRecoveryConfig(address, apiKey)
      .then((response) => {
        if (!cancelled) setChains(response.chains);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [address, apiKey, chainId, enabled]);

  if (!enabled) return { config: null, chains: [], loading: false, problem: null };
  if (failed) return { config: null, chains: [], loading: false, problem: 'lookup-failed' };
  // Derived, not stored: a `loading` initialised to false would report "no problem" for the first
  // render, briefly enabling Continue on an account nothing is known about yet.
  if (!chains) return { config: null, chains: [], loading: true, problem: null };

  const config = chains.find((chain) => chain.chainId === chainId) ?? null;
  return { config, chains, loading: false, problem: config ? null : 'unsupported-chain' };
}
