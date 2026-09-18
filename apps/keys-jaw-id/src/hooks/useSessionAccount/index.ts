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

  // Extract API key from chain.rpcUrl if there is one to extract. Undefined
  // rather than '': a keyless session has no key anywhere, and treating that as
  // missing data is what left `account` null for the whole session, so every
  // dialog answered "Account not initialized" on Confirm.
  const effectiveApiKey = useMemo(() => {
    if (apiKey) return apiKey;
    if (chain?.rpcUrl) {
      try {
        return new URL(chain.rpcUrl).searchParams.get('api-key') ?? undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }, [apiKey, chain?.rpcUrl]);

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

    // Skip if already initializing or already initialized with same params
    if (isInitializingRef.current || lastInitKeyRef.current === initKey) {
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
      }
    };

    initAccount();
  }, [chain, credentialId, publicKey, effectiveApiKey, restoreAccount, initKey]);

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
