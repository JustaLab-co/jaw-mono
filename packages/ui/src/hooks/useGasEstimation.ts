import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Address, Hex } from 'viem';
import type { Account, TokenEstimate, TransactionCall } from '@jaw.id/core';
import { estimateErc20PaymasterCosts, jawPaymasterUrl } from '@jaw.id/core';
import type { FeeTokenOption } from '../components/FeeTokenSelector';
import { classifyRevert, INSUFFICIENT_FUNDS_ERROR } from '../utils/transactionFailure';

// ============================================================================
// Types
// ============================================================================

// Re-export TransactionCall from core for consumers
export type { TransactionCall } from '@jaw.id/core';

/**
 * Configuration options for gas estimation
 */
export interface UseGasEstimationConfig {
  /** The Account instance to estimate gas for */
  account: Account | null;
  /** Array of transaction calls to estimate */
  transactionCalls: TransactionCall[];
  /** Chain ID for the estimation */
  chainId: number;
  /** API key for paymaster access */
  apiKey?: string;
  /** Available fee tokens (ETH + ERC-20) */
  feeTokens: FeeTokenOption[];
  /** Whether the transaction is sponsored (gas covered by paymaster) */
  isSponsored?: boolean;
  /** Optional permission ID for permission-based execution */
  permissionId?: Hex;
  /** Override account address — estimate gas for a different account this passkey owns */
  address?: Address;
  /** Callback when fee tokens are updated with estimates */
  onFeeTokensUpdate?: (tokens: FeeTokenOption[]) => void;
}

/**
 * Result returned by the useGasEstimation hook
 */
export interface UseGasEstimationResult {
  /** Estimated gas fee in ETH (as string) or 'sponsored' */
  gasFee: string;
  /** Whether gas estimation is in progress */
  gasFeeLoading: boolean;
  /** Error message if estimation failed */
  gasEstimationError: string;
  /** Token cost estimates for ERC-20 payment options */
  tokenEstimates: TokenEstimate[];
  /** Whether ERC-20 token cost estimation is in progress */
  estimatingTokenCosts: boolean;
  /** Currently selected fee token */
  selectedFeeToken: FeeTokenOption | null;
  /** Function to manually select a fee token */
  setSelectedFeeToken: (token: FeeTokenOption | null) => void;
  /** Whether user is paying with ERC-20 (not ETH, not sponsored) */
  isPayingWithErc20: boolean;
  /** Re-estimate gas (useful after transaction changes) */
  refetch: () => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Fallback gas estimate in ETH for L2 chains when ETH estimation fails */
const FALLBACK_GAS_ESTIMATE_ETH = '0.00005';

/**
 * Bundler markers for "the account can't cover the gas prefund" — the one failure a
 * fee-token switch actually fixes.
 *
 * Deliberately not a bare `'insufficient'`. These are substring matches, and that word
 * also appears in the transaction's OWN reverts (`INSUFFICIENT_OUTPUT_AMOUNT`,
 * `insufficient allowance`, `InsufficientCollateral`), which no fee token can fix.
 * Matching those here would re-route the fee and clear the error instead of reporting
 * the revert.
 */
const PREFUND_ERRORS = [
  'AA21',
  "didn't pay prefund",
  'insufficient funds for gas', // geth/bundler wording for a genuine prefund shortfall
  'AA50', // PostOp reverted (e.g., paymaster insufficient balance)
  'paymasterValidationGasLimit is required', // ERC-20 paymaster can't validate with 0 balance
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Whether the account couldn't cover the gas prefund — i.e. switching fee token may help.
 *
 * Specificity is the whole mechanism: every marker names gas payment or paymaster
 * validation, so a call-level revert can't match one and gets reported instead of
 * silently re-routed. Note `classifyRevert` cannot be used to pre-filter here — geth's
 * prefund message begins with "insufficient funds", which it (correctly, for its own
 * purpose) reads as a balance shortfall.
 */
function isPrefundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return PREFUND_ERRORS.some((msg) => error.message.toLowerCase().includes(msg.toLowerCase()));
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for estimating gas costs in both ETH and ERC-20 tokens.
 *
 * Features:
 * - Parallel estimation of ETH and ERC-20 costs using Promise.allSettled
 * - Automatic fallback to ERC-20 when ETH balance is insufficient
 * - Smart token selection based on available balances
 * - Loading states for smooth UI transitions
 *
 * @example
 * ```tsx
 * const {
 *   gasFee,
 *   gasFeeLoading,
 *   selectedFeeToken,
 *   setSelectedFeeToken,
 *   isPayingWithErc20,
 * } = useGasEstimation({
 *   account,
 *   transactionCalls,
 *   chainId: 84532,
 *   apiKey: 'your-api-key',
 *   feeTokens,
 *   onFeeTokensUpdate: setFeeTokens,
 * });
 * ```
 */
export function useGasEstimation({
  account,
  transactionCalls,
  chainId,
  apiKey,
  feeTokens,
  isSponsored = false,
  permissionId,
  address,
  onFeeTokensUpdate,
}: UseGasEstimationConfig): UseGasEstimationResult {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const [gasFee, setGasFee] = useState<string>('');
  const [gasFeeLoading, setGasFeeLoading] = useState<boolean>(true);
  const [gasEstimationError, setGasEstimationError] = useState<string>('');
  const [tokenEstimates, setTokenEstimates] = useState<TokenEstimate[]>([]);
  const [estimatingTokenCosts, setEstimatingTokenCosts] = useState<boolean>(false);
  const [selectedFeeToken, setSelectedFeeToken] = useState<FeeTokenOption | null>(null);

  // Track estimation version to handle race conditions
  const estimationVersionRef = useRef<number>(0);

  // Latest displayed fee, read inside estimateGas without making it a dependency.
  const gasFeeRef = useRef<string>('');
  gasFeeRef.current = gasFee;

  // Use refs for values that shouldn't trigger re-estimation
  const feeTokensRef = useRef(feeTokens);
  feeTokensRef.current = feeTokens;

  const onFeeTokensUpdateRef = useRef(onFeeTokensUpdate);
  onFeeTokensUpdateRef.current = onFeeTokensUpdate;

  // The ETH estimate depends on the calls, the account and the endpoint, never on the fee-token
  // list. Keyed separately so the list arriving later doesn't force a second identical bundler
  // round-trip. `apiKey` and `isSponsored` are inputs too: a fee measured before the key arrived
  // (or while sponsored) must not be reused as if it were measured for the current setup.
  const ethInputsKey = useMemo(
    () =>
      JSON.stringify([
        chainId,
        permissionId ?? null,
        address ?? null,
        apiKey ?? null,
        isSponsored,
        transactionCalls.map((c) => [c.to, c.value?.toString() ?? null, c.data ?? null]),
      ]),
    [chainId, permissionId, address, apiKey, isSponsored, transactionCalls]
  );
  const ethEstimatedForRef = useRef<string>('');

  // Track ERC-20 token addresses to re-run estimation when new tokens are added
  // This is stable when only gasCostFormatted/isSelectable change (preventing infinite loops)
  const erc20TokenAddresses = useMemo(
    () =>
      feeTokens
        .filter((t) => !t.isNative)
        .map((t) => t.address.toLowerCase())
        .sort()
        .join(','),
    [feeTokens]
  );

  // -------------------------------------------------------------------------
  // Derived State
  // -------------------------------------------------------------------------

  const isPayingWithErc20 = !isSponsored && !!selectedFeeToken && !selectedFeeToken.isNative;

  // -------------------------------------------------------------------------
  // Sync selected token when feeTokens update
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!selectedFeeToken || selectedFeeToken.isNative) return;

    const updatedToken = feeTokens.find((t) => t.address.toLowerCase() === selectedFeeToken.address.toLowerCase());

    // Update if either fee value changed (new estimate came in) — the ceiling can
    // move even when the realistic display rounds to the same string.
    if (
      updatedToken &&
      (updatedToken.gasCostFormatted !== selectedFeeToken.gasCostFormatted ||
        updatedToken.gasCostMaxFormatted !== selectedFeeToken.gasCostMaxFormatted)
    ) {
      setSelectedFeeToken(updatedToken);
    }
  }, [feeTokens, selectedFeeToken]);

  // -------------------------------------------------------------------------
  // Main Estimation Logic
  // -------------------------------------------------------------------------

  const estimateGas = useCallback(async () => {
    // Validation - keep loading state true while waiting for account
    if (!account) {
      // Don't set loading to false here - we're still waiting for prerequisites
      return;
    }

    // Handle sponsored transactions
    if (isSponsored) {
      setGasFee('sponsored');
      setGasFeeLoading(false);
      setGasEstimationError('');
      return;
    }

    // Handle empty transactionCalls (e.g., for permission grants)
    // Use a fallback gas estimate and still run ERC-20 estimation with a dummy call
    // Using zero address as dummy target for estimation purposes
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
    const effectiveCalls = transactionCalls.length > 0 ? transactionCalls : [{ to: ZERO_ADDRESS, value: 0n }]; // Dummy call for estimation

    // Increment version to track this estimation
    const currentVersion = ++estimationVersionRef.current;

    // Re-estimating with unchanged inputs (the ERC-20 token list arrived) must not blank a fee
    // that's already on screen — the row would fall back to "Estimating..." after having shown a
    // value. But a changed key means the fee on screen was measured for a *different* userOp: the
    // permission dialogs' first pass runs against a dummy call before the real one is built, and
    // that number must read as loading rather than pass as final.
    if (ethEstimatedForRef.current !== ethInputsKey) setGasFeeLoading(true);
    setEstimatingTokenCosts(true);
    setGasEstimationError('');

    try {
      // Use refs to avoid infinite loops (these values shouldn't trigger re-estimation)
      const currentFeeTokens = feeTokensRef.current;
      const erc20Tokens = currentFeeTokens.filter((t) => !t.isNative);
      // Filter tokens with balance > 0 for estimation (paymaster can't validate with 0 balance)
      const erc20TokensWithBalance = erc20Tokens.filter((t) => t.balance > 0n);
      const paymasterUrl = jawPaymasterUrl(chainId, apiKey);

      // Convert effectiveCalls to ensure value is bigint for estimateErc20PaymasterCosts
      const callsWithBigIntValue = effectiveCalls.map((call) => ({
        to: call.to as Address,
        value:
          call.value !== undefined ? (typeof call.value === 'string' ? BigInt(call.value) : call.value) : undefined,
        data: call.data as Hex | undefined,
      }));

      // Resolve the correct smart account for estimation (handles address override)
      const resolvedSmartAccount = await account.getSmartAccountFor(address);

      // Run ETH and ERC-20 estimation in parallel. The ETH leg is skipped when nothing it
      // depends on has changed — re-running it just to pick up the fee-token list would repeat
      // a bundler round-trip for a result we already have.
      // Only a real measured fee is reusable — never the 'sponsored' sentinel, and only when
      // the inputs it was measured for are unchanged.
      const reuseEthEstimate =
        ethEstimatedForRef.current === ethInputsKey && !!gasFeeRef.current && gasFeeRef.current !== 'sponsored';
      const [ethResult, erc20Result] = await Promise.allSettled([
        // ETH gas estimation
        reuseEthEstimate
          ? Promise.resolve(gasFeeRef.current)
          : account.calculateGasCost(effectiveCalls, permissionId || address ? { permissionId, address } : undefined),
        // ERC-20 gas estimation (only for tokens with balance > 0)
        // Tokens with 0 balance will be marked as not selectable below
        erc20TokensWithBalance.length > 0
          ? estimateErc20PaymasterCosts(
              resolvedSmartAccount,
              callsWithBigIntValue,
              account.getChain(),
              paymasterUrl,
              erc20TokensWithBalance.map((t) => ({
                address: t.address as Address,
                symbol: t.symbol,
                decimals: t.decimals,
                balance: t.balance,
              })),
              permissionId ? { permissionId, apiKey } : undefined
            )
          : Promise.resolve([]),
      ]);

      // Check if this estimation is still current (handle race conditions)
      if (currentVersion !== estimationVersionRef.current) {
        return;
      }

      // Process ERC-20 results first (so we have updated feeTokens for decision making)
      let updatedFeeTokens = [...currentFeeTokens];
      let erc20Estimates: TokenEstimate[] = [];

      if (erc20Result.status === 'fulfilled') {
        erc20Estimates = erc20Result.value;
        setTokenEstimates(erc20Estimates);

        // Update feeTokens with the estimated costs and selectability
        updatedFeeTokens = currentFeeTokens.map((token) => {
          if (token.isNative) return token;

          // Tokens with 0 balance are not selectable (can't pay gas fees)
          if (token.balance === 0n) {
            return {
              ...token,
              gasCostFormatted: undefined, // No estimate available
              gasCostMaxFormatted: undefined,
              isSelectable: false,
            };
          }

          const estimate = erc20Estimates.find((e) => e.tokenAddress.toLowerCase() === token.address.toLowerCase());

          if (estimate) {
            return {
              ...token,
              gasCostFormatted: estimate.tokenCostFormatted,
              gasCostMaxFormatted: estimate.tokenCostMaxFormatted,
              isSelectable: estimate.hasSufficientBalance,
            };
          }
          return token;
        });

        // Notify parent of updated tokens (use ref to avoid infinite loop)
        onFeeTokensUpdateRef.current?.(updatedFeeTokens);
      } else if (erc20Result.status === 'rejected') {
        // Check if this is an insufficient balance error (expected case, not a real error)
        const isInsufficientBalance = isPrefundError(erc20Result.reason);

        if (isInsufficientBalance) {
          // This is an expected case - user doesn't have enough ERC-20 tokens
          // Don't log as error, just mark tokens as insufficient
          updatedFeeTokens = currentFeeTokens.map((token) => {
            if (token.isNative) return token;

            // Tokens with 0 balance are not selectable
            if (token.balance === 0n) {
              return {
                ...token,
                gasCostFormatted: undefined,
                gasCostMaxFormatted: undefined,
                isSelectable: false,
              };
            }

            // Try to extract the required amount from the error message
            // Format: "X.XXX USDC required but sender has Y USDC"
            let gasCostFormatted = 'Insufficient';
            const errorMsg = erc20Result.reason instanceof Error ? erc20Result.reason.message : '';
            const match = errorMsg.match(/([\d.]+)\s*(\w+)\s*required/i);
            if (match) {
              gasCostFormatted = match[1]; // Just the amount, symbol is already shown
            }

            return {
              ...token,
              gasCostFormatted,
              gasCostMaxFormatted: undefined,
              isSelectable: false,
            };
          });
        } else {
          // Unexpected error - log it and show estimation failed
          console.error('[useGasEstimation] ERC-20 estimation failed:', erc20Result.reason);
          updatedFeeTokens = currentFeeTokens.map((token) => {
            if (token.isNative) return token;

            // Tokens with 0 balance - just mark as not selectable without error message
            if (token.balance === 0n) {
              return {
                ...token,
                gasCostFormatted: undefined,
                gasCostMaxFormatted: undefined,
                isSelectable: false,
              };
            }

            return {
              ...token,
              gasCostFormatted: 'Estimation failed',
              gasCostMaxFormatted: undefined,
              isSelectable: false,
            };
          });
        }
        onFeeTokensUpdateRef.current?.(updatedFeeTokens);
      }

      // Process ETH result
      const ethSuccess = ethResult.status === 'fulfilled';
      const ethInsufficientFunds = ethResult.status === 'rejected' && isPrefundError(ethResult.reason);

      if (ethSuccess) {
        ethEstimatedForRef.current = ethInputsKey;
        handleEthSuccess(ethResult.value, updatedFeeTokens);
      } else if (ethInsufficientFunds) {
        // Defensive: this branch only runs when the ETH leg was actually measured, so the key is
        // already stale — but a fallback fee must never become reusable if that ever changes.
        ethEstimatedForRef.current = '';
        handleEthInsufficientFunds(updatedFeeTokens);
      } else {
        ethEstimatedForRef.current = '';
        handleEstimationError(ethResult.status === 'rejected' ? ethResult.reason : null, updatedFeeTokens);
      }
    } catch (error) {
      // Check if this estimation is still current
      if (currentVersion !== estimationVersionRef.current) {
        return;
      }
      ethEstimatedForRef.current = '';
      handleEstimationError(error);
    } finally {
      // Only update loading states if this is still the current estimation
      if (currentVersion === estimationVersionRef.current) {
        setGasFeeLoading(false);
        setEstimatingTokenCosts(false);
      }
    }
    // Note: feeTokens and onFeeTokensUpdate accessed via refs to prevent infinite loops
    // erc20TokenAddresses triggers re-estimation when new ERC-20 tokens are added (but not when estimates update)
  }, [
    account,
    transactionCalls,
    chainId,
    apiKey,
    isSponsored,
    permissionId,
    address,
    erc20TokenAddresses,
    ethInputsKey,
  ]);

  /** Explicit refetch discards the reuse key so the ETH leg is genuinely re-measured. */
  const forceRefetch = useCallback(() => {
    ethEstimatedForRef.current = '';
    void estimateGas();
  }, [estimateGas]);

  // -------------------------------------------------------------------------
  // Result Handlers
  // -------------------------------------------------------------------------

  /**
   * Handle successful ETH gas estimation
   */
  const handleEthSuccess = useCallback((gasPrice: string, updatedFeeTokens: FeeTokenOption[]) => {
    setGasFee(gasPrice);
    setGasEstimationError('');

    // Auto-select native only when nothing is selected — decided inside the updater, because
    // `estimateGas` holds the callback from when the estimation started: a closure read would
    // see the stale null and overwrite a token the user picked while it was in flight.
    setSelectedFeeToken((prev) => prev ?? updatedFeeTokens.find((t) => t.isNative && t.isSelectable) ?? prev);
  }, []);

  /**
   * Handle ETH insufficient funds - try to fallback to ERC-20
   */
  const handleEthInsufficientFunds = useCallback((updatedFeeTokens: FeeTokenOption[]) => {
    const selectableErc20 = updatedFeeTokens.find((t) => !t.isNative && t.isSelectable);

    if (selectableErc20) {
      // Auto-select an ERC-20, keeping the user's own choice when it can still pay.
      setSelectedFeeToken((prev) => {
        const prevUpdated =
          prev && !prev.isNative
            ? updatedFeeTokens.find((t) => t.address.toLowerCase() === prev.address.toLowerCase())
            : undefined;
        return prevUpdated?.isSelectable ? prevUpdated : selectableErc20;
      });
      setGasFee(FALLBACK_GAS_ESTIMATE_ETH);
      setGasEstimationError('');
    } else {
      // No selectable payment options (neither ETH nor ERC-20 have sufficient balance)
      setGasFee('');
      setGasEstimationError(INSUFFICIENT_FUNDS_ERROR);
    }
  }, []);

  /**
   * A bundler error usually carries the execution revert reason, so a balance shortfall is
   * detectable here too and reported with the same string — never re-routed to a fee token,
   * the wrong remedy when gas is affordable and only the transfer isn't.
   *
   * Any other failure falls back to an ERC-20 that carries a priced ceiling: the ceiling only
   * exists when the paymaster userOp — same calls, same bundler — estimated successfully, so
   * the failure was specific to paying in ETH and the switch provably fixes it. A call revert
   * fails both estimations alike (tokens end up unselectable), so it can't be masked here; the
   * asset preview warns about reverts independently. `isSelectable` alone isn't proof — before
   * estimates land it's a balance heuristic from the fee-token producer, and a token without a
   * ceiling can't be confirmed anyway. `updatedFeeTokens` is empty on the outer-catch path,
   * where nothing has been proven.
   */
  const handleEstimationError = useCallback((error: unknown, updatedFeeTokens: FeeTokenOption[] = []) => {
    console.error('[useGasEstimation] Error:', error);
    if (classifyRevert(error) === 'balance') {
      setGasFee('');
      setGasEstimationError(INSUFFICIENT_FUNDS_ERROR);
      return;
    }
    const provenErc20 = (t: FeeTokenOption) => !t.isNative && t.isSelectable && !!t.gasCostMaxFormatted;
    const selectableErc20 = updatedFeeTokens.find(provenErc20);
    if (selectableErc20) {
      // Keep the user's own choice when it is itself proven; otherwise take the first that is.
      setSelectedFeeToken((prev) => {
        const prevUpdated =
          prev && !prev.isNative
            ? updatedFeeTokens.find((t) => t.address.toLowerCase() === prev.address.toLowerCase())
            : undefined;
        return prevUpdated && provenErc20(prevUpdated) ? prevUpdated : selectableErc20;
      });
      setGasFee(FALLBACK_GAS_ESTIMATE_ETH);
      setGasEstimationError('');
      return;
    }
    setGasFee('');
    setGasEstimationError('Failed to estimate gas');
  }, []);

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  // Run estimation when dependencies change
  useEffect(() => {
    estimateGas();
  }, [estimateGas]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    gasFee,
    gasFeeLoading,
    gasEstimationError,
    tokenEstimates,
    estimatingTokenCosts,
    selectedFeeToken,
    setSelectedFeeToken,
    isPayingWithErc20,
    refetch: forceRefetch,
  };
}
