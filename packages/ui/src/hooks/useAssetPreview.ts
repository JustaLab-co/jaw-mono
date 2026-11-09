import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { TransactionCall } from '@jaw.id/core';
import { simulateAssetChanges, type AssetDelta } from '../utils/assetPreview';
import type { RevertCause } from '../utils/transactionFailure';

export interface UseAssetPreviewConfig {
  account?: Address;
  calls: TransactionCall[];
  chainId: number;
  apiKey?: string;
  enabled?: boolean;
}

export interface UseAssetPreviewResult {
  assetsOut: AssetDelta[];
  assetsIn: AssetDelta[];
  error: boolean;
  /** The simulation is running for the current calls. */
  loading: boolean;
  /** The simulation answered for the current calls, so `willRevert` is its verdict. */
  simulated: boolean;
  /** True when the simulation ran and a call in the batch reverted — the batch would fail on-chain. */
  willRevert: boolean;
  /** Set only when `willRevert` — why it reverted, so a balance shortfall can read as "insufficient funds". */
  revertCause?: RevertCause;
}

/**
 * Simulate a batch and split the net balance changes into outgoing/incoming.
 * Errors are swallowed into `error` so a failed/unsupported simulation never blocks signing.
 */
export function useAssetPreview({
  account,
  calls,
  chainId,
  apiKey,
  enabled = true,
}: UseAssetPreviewConfig): UseAssetPreviewResult {
  const [assetsOut, setAssetsOut] = useState<AssetDelta[]>([]);
  const [assetsIn, setAssetsIn] = useState<AssetDelta[]>([]);
  const [error, setError] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [willRevert, setWillRevert] = useState<boolean>(false);
  const [revertCause, setRevertCause] = useState<RevertCause | undefined>(undefined);

  // Collision-safe content key so the effect re-runs only when the batch actually changes.
  const callsKey = JSON.stringify(calls.map((c) => [c.to, c.value?.toString(), c.data]));

  useEffect(() => {
    if (!enabled || !account || calls.length === 0) {
      setAssetsOut([]);
      setAssetsIn([]);
      setError(false);
      setLoading(false);
      setSimulated(false);
      setWillRevert(false);
      setRevertCause(undefined);
      return;
    }

    let cancelled = false;
    setError(false);
    setLoading(true);
    setSimulated(false);
    setWillRevert(false);
    setRevertCause(undefined);

    simulateAssetChanges({ chainId, apiKey, account, calls })
      .then(({ deltas, willRevert, revertCause, unreadable }) => {
        if (cancelled) return;
        setLoading(false);
        setError(!!unreadable);
        setSimulated(true);
        setWillRevert(willRevert);
        setRevertCause(revertCause);
        setAssetsOut(deltas.filter((d) => d.direction === 'out'));
        setAssetsIn(deltas.filter((d) => d.direction === 'in'));
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setError(true);
        setAssetsOut([]);
        setAssetsIn([]);
        setWillRevert(false);
        setRevertCause(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, account, chainId, apiKey, callsKey]);

  return { assetsOut, assetsIn, error, loading, simulated, willRevert, revertCause };
}
