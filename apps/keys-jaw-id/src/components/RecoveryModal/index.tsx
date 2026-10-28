'use client';

import {
  RecoveryDialog,
  useGasEstimation,
  useRecoveryConfig,
  type FeeTokenOption,
  fetchTokenBalance,
  isNativeToken,
  recoveryPlanStillHolds,
} from '@jaw.id/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { getChainNameFromId } from '../../lib/chain-handlers';
import { useSessionAccount } from '../../hooks';
import {
  type Chain,
  type RecoveryConfig,
  type RecoverySetupResult,
  buildErc20PaymasterContext,
  buildRecoverySetupCalls,
  getRecoveryConfig,
  normalizeSetupRecoveryParams,
  isFirstRecoverySetup,
  standardErrorCodes,
  jawPaymasterUrl,
  JAW_RPC_URL,
  SUPPORTED_CHAINS,
  handleGetCapabilitiesRequest,
} from '@jaw.id/core';
import { apiKeyFromChain } from '../../lib/api-key';

export interface RecoveryModalProps {
  /** The dApp's params: the config to show, validated again here, and its capabilities. */
  params?: unknown;
  chain?: Chain;
  apiKey: string;
  origin?: string;
  appName?: string;
  appLogoUrl?: string;
  /** Done on the last screen, with the latest status per network. */
  onSuccess?: (result: RecoverySetupResult) => void;
  onError?: (error: Error, errorCode?: number) => void;
}

/**
 * The CrossPlatform host for `wallet_setupRecovery`: the SDK's RecoveryDialogWrapper in keys'
 * conventions, as PermissionModal is PermissionDialogWrapper.
 *
 * The app sends the end state and the screen shows it for approval, as PermissionModal does
 * (R16): nothing on it is editable. The params are validated again here with the SDK's own
 * normalizer, since a page can post to keys without going through the SDK, and an invalid
 * config is refused with -32602 before anything is shown.
 *
 * The configs read picks the flow for the connected network: no recovery there is a first setup
 * through the account door (one userOp, the fee row below); recovery there is an edit, one
 * signature relayed by JAW to every network where it is on. `Account.setupRecovery` makes the
 * same read and the same choice.
 */
export const RecoveryModal = ({
  params,
  chain,
  apiKey,
  origin,
  appName,
  appLogoUrl,
  onSuccess,
  onError,
}: RecoveryModalProps) => {
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

  const [status, setStatus] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [feeTokens, setFeeTokens] = useState<FeeTokenOption[]>([]);
  const [feeTokensLoading, setFeeTokensLoading] = useState<boolean>(true);
  // Synchronous re-entry guard: isProcessing disables the buttons only after a
  // re-render, which is too soft a gate for a change to who can take over the account.
  const submittingRef = useRef(false);
  // The request is answered once. The done screen stays up while the page delivers the
  // answer, so a second Done (or a Confirm after a failure was reported) must not answer again.
  const settledRef = useRef(false);

  const extractedApiKey = useMemo(() => apiKeyFromChain(apiKey, chain?.rpcUrl), [apiKey, chain?.rpcUrl]);

  // Compute mainnet RPC URL for JustaName SDK (ENS resolution)
  const mainnetRpcUrl = useMemo(() => {
    return extractedApiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${extractedApiKey}` : `${JAW_RPC_URL}?chainId=1`;
  }, [extractedApiKey]);

  // The config the app sent, shown and signed as it is; an error when it is not one.
  const request = useMemo(() => {
    try {
      return normalizeSetupRecoveryParams(params);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }, [params]);
  const invalid = request instanceof Error ? request : null;
  const desired = useMemo<RecoveryConfig | null>(
    () => (request instanceof Error ? null : { recoveries: request.recoveries, threshold: request.threshold }),
    [request]
  );
  const capabilities = request instanceof Error ? undefined : request.capabilities;

  // Extract paymasterUrl from capabilities (EIP-5792 paymasterService capability)
  // Priority: capabilities.paymasterService.url > chain.paymaster.url
  const effectivePaymasterUrl = useMemo(() => {
    return capabilities?.paymasterService?.url || chain?.paymaster?.url;
  }, [capabilities, chain?.paymaster?.url]);

  // Extract paymasterContext from capabilities (for ERC-20 token payments, mode flags, etc.)
  // Priority: capabilities.paymasterService.context > chain.paymaster.context
  const effectivePaymasterContext = useMemo(() => {
    return capabilities?.paymasterService?.context || chain?.paymaster?.context;
  }, [capabilities, chain?.paymaster?.context]);

  // Recovery is account-level: the request carries the connected chain, where a first setup lands.
  const chainId = chain?.id;

  // Get viem chain for fee token fetching
  const viemChain = useMemo(() => {
    if (!chainId) return null;
    return SUPPORTED_CHAINS.find((c) => c.id === chainId);
  }, [chainId]);

  // Check if this is a sponsored transaction (paymaster provided)
  const isSponsored = !!effectivePaymasterUrl;

  const accountAddress = (walletAddress ?? undefined) as Address | undefined;

  const {
    config,
    chains,
    loading: isLoadingConfig,
    problem,
  } = useRecoveryConfig({ address: accountAddress, apiKey: extractedApiKey, chainId });
  const isFirstSetup = !config || isFirstRecoverySetup(config);

  // The account-door userOp of a first setup, built from the config under review so the fee is
  // estimated over exactly what will be sent. An edit is relayed and costs the user nothing.
  const transactionCalls = useMemo(() => {
    if (!desired || !config || !isFirstSetup || !accountAddress) return [];
    try {
      return buildRecoverySetupCalls(accountAddress, config, desired);
    } catch (error) {
      console.warn('[RecoveryModal] Failed to build recovery setup calls:', error);
      return [];
    }
  }, [desired, config, isFirstSetup, accountAddress]);

  // Use the gas estimation hook for both ETH and ERC-20 cost estimation
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
    chainId: chainId || 1,
    apiKey: extractedApiKey,
    feeTokens,
    // Nothing to price until a first setup is under review.
    isSponsored: isSponsored || transactionCalls.length === 0,
    address: accountAddress,
    onFeeTokensUpdate: setFeeTokens,
  });

  // Compute paymaster URL based on fee token selection (for ERC-20 paymaster)
  const computedPaymasterUrl = useMemo(() => {
    // If already sponsored via capabilities or config, use that
    if (effectivePaymasterUrl) return effectivePaymasterUrl;

    // If user selected an ERC-20 token (non-native), use ERC-20 paymaster.
    // No chain is no paymaster, as in PermissionModal.
    if (selectedFeeToken && !selectedFeeToken.isNative && chainId !== undefined) {
      return jawPaymasterUrl(chainId, extractedApiKey);
    }

    // Native ETH - no paymaster needed
    return undefined;
  }, [effectivePaymasterUrl, selectedFeeToken, chainId, extractedApiKey]);

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

  // Network name
  const networkName = useMemo(() => {
    if (!chainId) return 'Ethereum Mainnet';
    return getChainNameFromId(chainId);
  }, [chainId]);

  // Fetch fee tokens (ETH + available ERC-20 tokens from chain config)
  useEffect(() => {
    // Skip if already sponsored via capabilities or config, or missing required data
    if (effectivePaymasterUrl || !chain || !walletAddress) {
      setFeeTokensLoading(false);
      return;
    }

    let isMounted = true;

    const fetchFeeTokensData = async () => {
      // The chain, and nothing else: keyless the capabilities come back on the
      // origin, as in PermissionModal.
      if (!viemChain) {
        setFeeTokensLoading(false);
        return;
      }

      try {
        setFeeTokensLoading(true);

        // Fetch capabilities from JAW RPC
        const capabilitiesResponse = await handleGetCapabilitiesRequest(
          { method: 'wallet_getCapabilities', params: [] },
          extractedApiKey,
          true // showTestnets
        );

        const chainIdHex = `0x${(chain?.id || 1).toString(16)}` as `0x${string}`;
        const feeTokenCap = capabilitiesResponse?.[chainIdHex]?.feeToken;

        if (!feeTokenCap?.supported || !feeTokenCap?.tokens?.length) {
          if (isMounted) setFeeTokensLoading(false);
          return;
        }

        // Get RPC URL for balance fetching
        const rpcUrl = chain?.rpcUrl || viemChain?.rpcUrls?.default?.http?.[0] || `https://eth.llamarpc.com`;

        // Fetch balances in parallel
        const tokensWithBalances = await Promise.all(
          feeTokenCap.tokens.map(async (token) => {
            try {
              const balance = await fetchTokenBalance(token.address, walletAddress, rpcUrl, chain?.id);
              const balanceFormatted = formatUnits(balance, token.decimals);
              const tokenIsNative = isNativeToken(token.address);
              // For native token (ETH): selectable if any balance (gas estimation will catch insufficient)
              // For ERC-20 tokens: require at least 0.5 units
              const isSelectable = tokenIsNative ? balance > 0n : parseFloat(balanceFormatted) >= 0.5;

              return {
                uid: token.uid,
                symbol: token.symbol,
                address: token.address,
                decimals: token.decimals,
                balance,
                balanceFormatted,
                isNative: tokenIsNative,
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
        }
      } catch (error) {
        console.warn('[RecoveryModal] Failed to fetch fee tokens:', error);
      } finally {
        if (isMounted) setFeeTokensLoading(false);
      }
    };

    fetchFeeTokensData();

    return () => {
      isMounted = false;
    };
  }, [chain, extractedApiKey, viemChain, walletAddress, effectivePaymasterUrl]);

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current || settledRef.current) return;
    submittingRef.current = true;
    try {
      setIsProcessing(true);
      setStatus(isFirstSetup ? 'Enabling recovery...' : 'Updating recovery...');

      if (!account) {
        throw new Error('Account not initialized. Please try again.');
      }

      if (!desired) {
        throw new Error('Recovery config is missing.');
      }

      // Account plans again from its own read when it signs. Refuse when that plan is no longer
      // the one this screen showed: a keys screen signs what it rendered.
      const fresh = await getRecoveryConfig(walletAddress as Address, extractedApiKey);
      if (!chainId || !recoveryPlanStillHolds(chains, fresh.chains, chainId, desired)) {
        throw new Error('Recovery settings changed since this screen opened. Close this and try again.');
      }

      // The config the confirm screen rendered, signed as is. The paymaster only applies to the
      // account door.
      const setup = await account.setupRecovery(desired, computedPaymasterUrl, computedPaymasterContext);
      setStatus('');
      // Answered at once, like every keys modal: once the change has landed, closing the window
      // must not report a rejection. The page's done screen follows; a relayed batch is the dApp's
      // to poll with `getAdminBatch`.
      settledRef.current = true;
      onSuccess?.(setup);
    } catch (error) {
      console.error('Recovery setup failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus(`Error: ${errorMessage}`);
      const errorObj = error instanceof Error ? error : new Error(errorMessage);
      // Check if user cancelled passkey prompt (NotAllowedError)
      const errorCode =
        error instanceof Error && error.name === 'NotAllowedError'
          ? standardErrorCodes.provider.userRejectedRequest
          : standardErrorCodes.rpc.internal;
      settledRef.current = true;
      onError?.(errorObj, errorCode);
    } finally {
      // Reset on success too: settledRef keeps a second answer out, and the page moves on.
      submittingRef.current = false;
      setIsProcessing(false);
    }
  }, [
    account,
    desired,
    isFirstSetup,
    walletAddress,
    extractedApiKey,
    chainId,
    chains,
    computedPaymasterUrl,
    computedPaymasterContext,
    onSuccess,
    onError,
  ]);

  // Only reached unsigned: a config the app manages that is already in place (the dialog's Done).
  const handleDone = useCallback(
    (latest: RecoverySetupResult) => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSuccess?.(latest);
    },
    [onSuccess]
  );

  // An invalid config has nothing to show: refused once, before anything renders.
  useEffect(() => {
    if (!invalid || settledRef.current) return;
    settledRef.current = true;
    onError?.(invalid, standardErrorCodes.rpc.invalidParams);
  }, [invalid, onError]);

  const handleCancel = useCallback(() => {
    // isProcessing commits a render late; a same-tick cancel must not report
    // "rejected" while the signed change proceeds and lands on chain.
    if (submittingRef.current) return;
    if (settledRef.current) return;
    settledRef.current = true;
    // User rejected request (EIP-1193 code 4001)
    onError?.(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
    setStatus('');
  }, [onError]);

  if (!desired) return null;

  return (
    <RecoveryDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) handleCancel();
      }}
      accountAddress={walletAddress ?? ''}
      origin={origin || ''}
      appName={appName}
      appLogoUrl={appLogoUrl}
      config={desired}
      current={config}
      chains={chains}
      isLoadingConfig={isLoadingConfig || isAccountLoading}
      problem={problem}
      networkName={networkName}
      chainId={chainId}
      apiKey={extractedApiKey}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      onDone={handleDone}
      isProcessing={isProcessing}
      status={status}
      result={null}
      gasFee={gasFee}
      gasFeeLoading={gasFeeLoading}
      gasEstimationError={gasEstimationError}
      sponsored={isSponsored}
      mainnetRpcUrl={mainnetRpcUrl}
      // Fee token props for ERC-20 paymaster
      feeTokens={feeTokens}
      feeTokensLoading={feeTokensLoading}
      selectedFeeToken={selectedFeeToken}
      onFeeTokenSelect={setSelectedFeeToken}
      showFeeTokenSelector={!isSponsored && feeTokens.length > 0}
      isPayingWithErc20={isPayingWithErc20}
      nativeCurrencySymbol={viemChain?.nativeCurrency?.symbol}
    />
  );
};
