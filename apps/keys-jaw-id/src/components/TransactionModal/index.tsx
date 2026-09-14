'use client';

import {
  TransactionDialog,
  TransactionData,
  FeeTokenOption,
  fetchTokenBalance,
  isNativeToken,
  useGasEstimation,
  useAssetPreview,
  usePermissionExecution,
} from '@jaw.id/ui';
import { debugLog } from '../../lib/debug-log';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Address, Hash, Hex, formatUnits } from 'viem';
import { getChainNameFromId } from '../../lib/chain-handlers';
import { useSessionAccount } from '../../hooks';
import {
  type Chain,
  type TransactionCall,
  standardErrorCodes,
  handleGetCapabilitiesRequest,
  buildErc20PaymasterContext,
  jawPaymasterUrl,
  JAW_RPC_URL,
} from '@jaw.id/core';

// Transaction execution result
export interface TransactionResult {
  hash?: Hash;
  sendCallsId?: string;
  userOpHash?: Hash;
  id?: Hash;
  chainId?: number;
}

// Transaction request data with method-specific metadata
export interface TransactionRequestData {
  method: 'wallet_sendCalls' | 'eth_sendTransaction';
  transactions: Array<{
    to?: string;
    data?: string;
    value: string;
    chainId: number;
  }>;
  chainId: number;
  paymasterUrl?: string;
  paymasterContext?: Record<string, unknown>;
  // wallet_sendCalls specific fields
  atomicRequired?: boolean;
  version?: string;
  callsId?: string;
  // Permission ID for permission-based execution
  permissionId?: `0x${string}`;
  // Account address to execute from
  from?: `0x${string}`;
}

export interface TransactionModalProps {
  transactionRequest?: TransactionRequestData;
  transactions?: TransactionData[];
  sponsored?: boolean;
  chain?: Chain; // Chain info with RPC and paymaster URLs
  apiKey?: string;
  origin?: string; // Origin for per-origin auth session
  appName?: string;
  appLogoUrl?: string;
  onSuccess?: (result: TransactionResult) => void;
  onError?: (error: Error, errorCode?: number) => void;
}

export const TransactionModal = ({
  transactionRequest,
  transactions,
  sponsored = false,
  chain,
  apiKey,
  origin,
  appName,
  appLogoUrl,
  onSuccess,
  onError,
}: TransactionModalProps) => {
  // Single hook handles session lookup + account restoration
  const {
    account,
    isLoading: isAccountLoading,
    walletAddress,
  } = useSessionAccount({
    origin,
    chain,
    apiKey,
  });

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  // Synchronous re-entry guard: isProcessing disables the button only after a
  // re-render, which is too soft a gate for a call that moves funds.
  const submittingRef = useRef(false);

  // Fee token state for ERC-20 paymaster
  const [feeTokens, setFeeTokens] = useState<FeeTokenOption[]>([]);
  const [feeTokensLoading, setFeeTokensLoading] = useState(false);

  // Extract API key from rpcUrl if not provided as prop
  const effectiveApiKey = useMemo(() => {
    if (apiKey) return apiKey;
    if (chain?.rpcUrl) {
      try {
        const url = new URL(chain.rpcUrl);
        return url.searchParams.get('api-key') || '';
      } catch {
        return '';
      }
    }
    return '';
  }, [apiKey, chain?.rpcUrl]);

  // Determine if sponsored based on transactionRequest or prop
  const isSponsored = useMemo(() => {
    if (transactionRequest) {
      return !!transactionRequest.paymasterUrl;
    }
    return sponsored;
  }, [transactionRequest, sponsored]);

  // Normalize transaction data - prioritize transactionRequest, then fallback to legacy transactions prop
  const normalizedTransactions = useMemo((): TransactionData[] => {
    // Use transactionRequest if available
    if (transactionRequest) {
      return transactionRequest.transactions.map((tx) => ({
        to: tx.to || '',
        data: tx.data || '0x',
        value: tx.value,
        chainId: tx.chainId,
      }));
    }

    // Legacy way: use transactions prop
    if (transactions && transactions.length > 0) {
      return transactions;
    }

    return [];
  }, [transactionRequest, transactions]);

  const networkName = useMemo(() => {
    // Use chain prop if available, otherwise fall back to transaction chainId
    const chainId = chain?.id ?? normalizedTransactions[0]?.chainId;

    if (!chainId) return 'Ethereum';

    // Use the getChainNameFromId utility which has comprehensive chain mapping
    return getChainNameFromId(chainId);
  }, [normalizedTransactions, chain]);

  const resetModalState = useCallback(() => {
    setIsProcessing(false);
  }, []);

  useEffect(() => {
    if (!chain) {
      resetModalState();
    }
  }, [chain, resetModalState]);

  // Extract paymasterUrl from capabilities (EIP-5792 paymasterService capability)
  // Priority: capabilities.paymasterService.url > chain.paymaster.url
  const effectivePaymasterUrl = useMemo(() => {
    if (transactionRequest?.paymasterUrl) {
      return transactionRequest.paymasterUrl;
    }
    return chain?.paymaster?.url;
  }, [transactionRequest?.paymasterUrl, chain?.paymaster?.url]);

  // Extract paymasterContext from capabilities (EIP-5792 paymasterService.context)
  // Priority: capabilities.paymasterService.context > chain.paymaster.context
  const effectivePaymasterContext = useMemo(() => {
    if (transactionRequest?.paymasterContext) {
      return transactionRequest.paymasterContext;
    }
    return chain?.paymaster?.context;
  }, [transactionRequest?.paymasterContext, chain?.paymaster?.context]);

  // Convert normalized transactions to TransactionCall format for gas estimation
  const transactionCalls = useMemo((): TransactionCall[] => {
    return normalizedTransactions.map((tx) => ({
      to: tx.to as Address,
      value: tx.value ? BigInt(tx.value) : undefined,
      data: (tx.data as `0x${string}`) || '0x',
    }));
  }, [normalizedTransactions]);

  // Permission ID for permission-based execution
  const permissionId = transactionRequest?.permissionId as Hex | undefined;

  // `from` is optional in wallet_sendCalls, so the dialog falls back to the connected account for
  // the From row. The permission check must read the same address, or a spender mismatch goes
  // unreported while the row still shows who is signing.
  const signerAddress = (transactionRequest?.from ?? walletAddress) as Address | undefined;

  const {
    onBehalfOf,
    loading: onBehalfOfLoading,
    problem: permissionProblem,
  } = usePermissionExecution({
    permissionId,
    apiKey: effectiveApiKey,
    chainId: chain?.id,
    from: signerAddress,
    calls: transactionCalls,
  });

  // Use gas estimation hook for parallel ETH and ERC-20 estimation
  const {
    gasFee,
    gasFeeLoading,
    gasEstimationError,
    tokenEstimates,
    selectedFeeToken,
    setSelectedFeeToken,
    isPayingWithErc20,
  } = useGasEstimation({
    account,
    transactionCalls,
    chainId: chain?.id ?? 1,
    apiKey: effectiveApiKey,
    feeTokens,
    isSponsored,
    permissionId,
    address: transactionRequest?.from,
    onFeeTokensUpdate: setFeeTokens,
  });

  const {
    assetsOut,
    assetsIn,
    error: assetPreviewError,
    willRevert: assetPreviewWillRevert,
    revertCause: assetPreviewRevertCause,
  } = useAssetPreview({
    // Under a permission the calls execute as the granter, so the balance changes are theirs.
    // Left undefined until the granter resolves: simulating from the spender would preview the
    // wrong account, and a shortfall there would briefly read as "Insufficient funds".
    account: permissionId ? onBehalfOf : signerAddress,
    calls: transactionCalls,
    chainId: chain?.id ?? 1,
    apiKey: effectiveApiKey,
    enabled: chain?.id !== undefined,
  });

  // Compute paymaster URL based on fee token selection (for ERC-20 paymaster)
  const computedPaymasterUrl = useMemo(() => {
    // If already sponsored via capabilities or config, use that
    if (effectivePaymasterUrl) return effectivePaymasterUrl;

    // If user selected an ERC-20 token (non-native), use ERC-20 paymaster.
    // No chain is no paymaster. Every reader of this value guards on `chain`
    // first, so the check states the requirement rather than handling a case
    // that fires; the two modals disagreed about it while it was implicit.
    if (selectedFeeToken && !selectedFeeToken.isNative && chain?.id !== undefined) {
      return jawPaymasterUrl(chain.id, effectiveApiKey);
    }

    // Native ETH - no paymaster needed
    return undefined;
  }, [effectivePaymasterUrl, selectedFeeToken, chain?.id, effectiveApiKey]);

  // Compute paymaster context based on fee token selection
  const computedPaymasterContext = useMemo(() => {
    // If using ERC-20 paymaster, include token address and gas amount in context
    if (selectedFeeToken && !selectedFeeToken.isNative) {
      // Use the actual estimate from tokenEstimates if available
      const estimate = tokenEstimates.find(
        (e) => e.tokenAddress.toLowerCase() === selectedFeeToken.address.toLowerCase()
      );

      if (estimate) {
        return buildErc20PaymasterContext(estimate);
      }

      // No estimate yet: omit `gas` so Account.createErc20ApprovalCall estimates
      // the worst-case ceiling itself, instead of a client-side USD guess that
      // ignores the exchange rate and can under-approve.
      return { token: selectedFeeToken.address };
    }
    return effectivePaymasterContext;
  }, [selectedFeeToken, effectivePaymasterContext, tokenEstimates]);

  // Determine if fee token selector should be shown
  const showFeeTokenSelector = !isSponsored && feeTokens.length > 0;

  // Fetch fee tokens when not sponsored (for ERC-20 paymaster option)
  useEffect(() => {
    // Skip if already sponsored via capabilities or config
    // Use override address for balance fetching when executing on behalf of another account
    const balanceAddress = transactionRequest?.from ?? walletAddress;
    if (effectivePaymasterUrl || !chain || !balanceAddress) return;

    let isMounted = true;

    const fetchFeeTokensData = async () => {
      setFeeTokensLoading(true);
      try {
        // Fetch capabilities from JAW RPC
        const capabilities = await handleGetCapabilitiesRequest(
          { method: 'wallet_getCapabilities', params: [] },
          effectiveApiKey || '',
          true // showTestnets
        );

        const chainIdHex = `0x${chain.id.toString(16)}` as `0x${string}`;
        const feeTokenCap = capabilities?.[chainIdHex]?.feeToken;

        if (!feeTokenCap?.supported || !feeTokenCap?.tokens?.length) {
          if (isMounted) setFeeTokensLoading(false);
          return;
        }

        // Get RPC URL for balance fetching
        const rpcUrl = chain.rpcUrl || `https://eth.llamarpc.com`;

        // Fetch balances in parallel
        const tokensWithBalances = await Promise.all(
          feeTokenCap.tokens.map(async (token) => {
            try {
              const balance = await fetchTokenBalance(token.address, balanceAddress, rpcUrl, chain.id);
              const balanceFormatted = formatUnits(balance, token.decimals);
              const isNative = isNativeToken(token.address);
              // For native token (ETH): selectable if any balance (gas estimation will catch insufficient)
              // For ERC-20 tokens: require at least 0.5 units
              const isSelectable = isNative ? balance > 0n : parseFloat(balanceFormatted) >= 0.5;

              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance,
                balanceFormatted,
                isNative,
                isSelectable,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            } catch (error) {
              console.warn(`Failed to fetch balance for ${token.symbol}:`, error);
              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance: 0n,
                balanceFormatted: '0',
                isNative: isNativeToken(token.address),
                isSelectable: false,
                logoURI: token.logoURI,
              } as FeeTokenOption;
            }
          })
        );

        if (isMounted) {
          setFeeTokens(tokensWithBalances);
          // Note: Initial token selection is handled by useGasEstimation hook
        }
      } catch (error) {
        console.warn('[TransactionModal] Failed to fetch fee tokens:', error);
      } finally {
        if (isMounted) setFeeTokensLoading(false);
      }
    };

    fetchFeeTokensData();

    return () => {
      isMounted = false;
    };
  }, [chain, effectiveApiKey, walletAddress, transactionRequest?.from, effectivePaymasterUrl]);

  // Note: Account initialization is handled by useSessionAccount hook
  // Note: Gas estimation is handled by useGasEstimation hook

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      setIsProcessing(true);

      if (!account) {
        throw new Error('Account not initialized. Please try again.');
      }

      if (!chain) {
        throw new Error('Chain information is required.');
      }

      // Convert normalized transactions to TransactionCall format
      const transactionCalls: TransactionCall[] = normalizedTransactions.map((tx) => ({
        to: tx.to as Address,
        value: tx.value ? BigInt(tx.value) : undefined, // Convert string wei to bigint
        data: (tx.data as `0x${string}`) || '0x',
      }));

      // Send transaction using Account class
      // Pass computed paymaster URL and context (includes ERC-20 paymaster if selected)
      let result: TransactionResult;
      // Use sendCalls for wallet_sendCalls, sendTransaction for eth_sendTransaction
      if (transactionRequest?.method === 'wallet_sendCalls') {
        // Build options with permissionId if available
        const options =
          transactionRequest?.permissionId || transactionRequest?.from
            ? { permissionId: transactionRequest?.permissionId, from: transactionRequest?.from }
            : undefined;

        const bundledResult = await account.sendCalls(
          transactionCalls,
          options,
          computedPaymasterUrl,
          computedPaymasterContext
        );
        // Return the transaction result with proper format based on method
        result = {
          id: bundledResult.id,
          chainId: bundledResult.chainId,
        };
      } else {
        const txHash = await account.sendTransaction(
          transactionCalls,
          computedPaymasterUrl,
          computedPaymasterContext,
          transactionRequest?.from
        );
        result = {
          hash: txHash,
        };
      }

      // Call onSuccess immediately - parent will handle closing
      onSuccess?.(result);
    } catch (error) {
      console.error('Error in transaction:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error instanceof Error ? error : new Error(errorMessage);
      // Determine error code based on error type
      let errorCode: number;
      if (error instanceof Error && error.name === 'NotAllowedError') {
        // User cancelled passkey prompt
        errorCode = standardErrorCodes.provider.userRejectedRequest;
      } else if (
        error instanceof Error &&
        (errorMessage.includes('AA21') ||
          errorMessage.includes("didn't pay prefund") ||
          errorMessage.includes('insufficient') ||
          errorMessage.includes('exceeds balance'))
      ) {
        // Transaction rejected due to funds/gas issues
        errorCode = standardErrorCodes.rpc.transactionRejected;
      } else {
        // Internal error
        errorCode = standardErrorCodes.rpc.internal;
      }
      onError?.(errorObj, errorCode);
      submittingRef.current = false;
      setIsProcessing(false);
    }
  }, [
    account,
    chain,
    normalizedTransactions,
    transactionRequest,
    computedPaymasterUrl,
    computedPaymasterContext,
    onSuccess,
    onError,
  ]);

  const handleCancel = useCallback(() => {
    // isProcessing commits a render late; a same-tick cancel must not report
    // "rejected" while the signed submission proceeds and lands on chain.
    if (submittingRef.current) return;
    if (!isProcessing) {
      debugLog('❌ User cancelled transaction request');
      // User rejected request (EIP-1193 code 4001)
      onError?.(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
      // Reset fee token state
      setFeeTokens([]);
      setSelectedFeeToken(null);
    }
  }, [isProcessing, onError, setSelectedFeeToken]);

  // Compute mainnet RPC URL for ENS resolution
  const mainnetRpcUrl = effectiveApiKey
    ? `${JAW_RPC_URL}?chainId=1&api-key=${effectiveApiKey}`
    : `${JAW_RPC_URL}?chainId=1`;

  return (
    <TransactionDialog
      // Mounting is controlled by the page (keyed per request), so the dialog is
      // always open while this component exists; dismissal routes through cancel.
      open={true}
      onOpenChange={(o) => {
        if (!o) handleCancel();
      }}
      transactions={normalizedTransactions}
      walletAddress={signerAddress ?? ''}
      gasFee={gasFee}
      gasFeeLoading={gasFeeLoading || isAccountLoading}
      gasEstimationError={gasEstimationError}
      sponsored={isSponsored}
      assetsOut={assetsOut}
      assetsIn={assetsIn}
      assetPreviewError={assetPreviewError}
      assetPreviewWillRevert={assetPreviewWillRevert}
      assetPreviewRevertCause={assetPreviewRevertCause}
      onBehalfOf={onBehalfOf}
      onBehalfOfLoading={onBehalfOfLoading}
      permissionProblem={permissionProblem}
      appName={appName}
      appLogoUrl={appLogoUrl}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      networkName={networkName ?? 'Ethereum'}
      apiKey={effectiveApiKey}
      mainnetRpcUrl={mainnetRpcUrl}
      // Fee token props for ERC-20 paymaster
      feeTokens={feeTokens}
      feeTokensLoading={feeTokensLoading}
      selectedFeeToken={selectedFeeToken}
      onFeeTokenSelect={setSelectedFeeToken}
      showFeeTokenSelector={showFeeTokenSelector}
      isPayingWithErc20={isPayingWithErc20}
      nativeCurrencySymbol={chain?.nativeCurrency?.symbol}
    />
  );
};
