/**
 * useSessionAccount Hook
 *
 * Restores an Account instance for a given origin using session credentials.
 * Handles loading, error states, and prevents duplicate initialization.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import { Account } from '@jaw.id/core';
import { useAuth } from '../useAuth';
import { usePasskeys } from '../usePasskeys';
import { apiKeyFromChain } from '../../lib/api-key';
import type { chain } from '../../lib/sdk-types';

export interface UseSessionAccountOptions {
  /** App origin for session lookup */
  origin?: string;
  /** Chain configuration */
  chain?: chain;
  /** API key (optional - can be extracted from chain.rpcUrl) */
  apiKey?: string;
}

export interface UseSessionAccountReturn {
  /** Restored Account instance */
  account: Account | null;
  /** Loading state */
  isLoading: boolean;
  /** Error if restoration failed */
  error: Error | null;
  /** Wallet address from session */
  walletAddress: string | null;
  /** Whether session is authenticated */
  isAuthenticated: boolean;
}

/**
 * Hook to restore an Account from session credentials.
 *
 * @example
 * ```tsx
 * const { account, isLoading, error } = useSessionAccount({
 *   origin: 'https://app.example.com',
 *   chain: { id: 1, rpcUrl: '...' },
 *   apiKey: 'xxx'
 * });
 *
 * if (isLoading) return <Spinner />;
 * if (error) return <Error message={error.message} />;
 * if (!account) return <NotAuthenticated />;
 * ```
 */
export function useSessionAccount(options: UseSessionAccountOptions = {}): UseSessionAccountReturn {
  const { origin, chain, apiKey } = options;

  // Get session data
  const { credentialId, publicKey, walletAddress, isAuthenticated } = useAuth({ origin });
  const { restoreAccount } = usePasskeys();

  // State
  const [account, setAccount] = useState<Account | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Prevent double initialization
  const isInitializingRef = useRef(false);
  const lastInitKeyRef = useRef<string>('');
  // A run skipped because another was in flight, and the counter that brings it
  // back: the deps that asked for it will not change again on their own.
  const supersededRef = useRef(false);
  const [restarts, setRestarts] = useState(0);

  const effectiveApiKey = useMemo(() => apiKeyFromChain(apiKey, chain?.rpcUrl), [apiKey, chain?.rpcUrl]);

  // Create a key to track what we're initializing for
  const initKey = useMemo(() => {
    if (!chain || !credentialId || !publicKey) return '';
    return `${chain.id}-${credentialId}-${effectiveApiKey ?? ''}`;
  }, [chain, credentialId, publicKey, effectiveApiKey]);

  useEffect(() => {
    // Skip if missing required data. The key is not part of it.
    if (!chain || !credentialId || !publicKey) {
      setIsLoading(false);
      return;
    }

    if (lastInitKeyRef.current === initKey) return;

    // Already restoring something else. The key can arrive after a keyless
    // restore has started, so this run is remembered and made again once that
    // one is done, rather than dropped.
    if (isInitializingRef.current) {
      supersededRef.current = true;
      return;
    }

    const initAccount = async () => {
      isInitializingRef.current = true;
      lastInitKeyRef.current = initKey;
      setIsLoading(true);
      setError(null);

      try {
        const restored = await restoreAccount(
          { id: chain.id, rpcUrl: chain.rpcUrl, paymaster: chain.paymaster },
          credentialId,
          publicKey,
          effectiveApiKey
        );
        setAccount(restored);
      } catch (err) {
        console.error('[useSessionAccount] Failed to restore account:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setAccount(null);
      } finally {
        setIsLoading(false);
        isInitializingRef.current = false;
        if (supersededRef.current) {
          supersededRef.current = false;
          setRestarts((n) => n + 1);
        }
      }
    };

    initAccount();
  }, [chain, credentialId, publicKey, effectiveApiKey, restoreAccount, initKey, restarts]);

  // Reset when origin changes (different session)
  useEffect(() => {
    setAccount(null);
    setError(null);
    lastInitKeyRef.current = '';
  }, [origin]);

  return {
    account,
    isLoading,
    error,
    walletAddress,
    isAuthenticated,
  };
}

export default useSessionAccount;
