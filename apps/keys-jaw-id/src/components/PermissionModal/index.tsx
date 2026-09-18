'use client';

import {
  PermissionDialog,
  useGasEstimation,
  type FeeTokenOption,
  fetchTokenBalance,
  formatSpendAmount,
  getPublicClient,
  useFunctionSignatures,
  isNativeToken,
  isWildcard,
  usePermissionRevocation,
  spendExposure,
} from '@jaw.id/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, erc20Abi, type Address } from 'viem';
import { getChainNameFromId } from '../../lib/chain-handlers';
import { useSessionAccount } from '../../hooks';
import {
  type Chain,
  type WalletGrantPermissionsRequest,
  type WalletRevokePermissionsRequest,
  type WalletGrantPermissionsResponse,
  type SpendPeriod,
  buildGrantPermissionCall,
  buildRevokePermissionCall,
  buildErc20PaymasterContext,
  standardErrorCodes,
  jawPaymasterUrl,
  JAW_RPC_URL,
  SUPPORTED_CHAINS,
  handleGetCapabilitiesRequest,
} from '@jaw.id/core';

// Known function selectors mapping
// Permission request data
export interface PermissionRequestData {
  method: 'wallet_grantPermissions' | 'wallet_revokePermissions';
  params: WalletGrantPermissionsRequest['params'] | WalletRevokePermissionsRequest['params'];
}

export interface PermissionModalProps {
  permissionRequest?: PermissionRequestData;
  chain?: Chain;
  apiKey: string;
  origin?: string;
  appName?: string;
  appLogoUrl?: string;
  onSuccess?: (result: WalletGrantPermissionsResponse | { success: boolean }) => void;
  onError?: (error: Error, errorCode?: number) => void;
}

// Format period to human-readable duration with multiplier support
const formatDuration = (period: SpendPeriod, multiplier = 1): string => {
  const periodLabels: Record<SpendPeriod, string> = {
    minute: 'Minute',
    hour: 'Hour',
    day: 'Day',
    week: 'Week',
    month: 'Month',
    year: 'Year',
    forever: 'Forever',
  };

  const label = periodLabels[period] || period;

  // Forever doesn't need a multiplier
  if (period === 'forever') {
    return 'Forever';
  }

  // Add 's' for plural when multiplier > 1
  const pluralSuffix = multiplier > 1 ? 's' : '';
  return `${multiplier} ${label}${pluralSuffix}`;
};

// Convert period unit and multiplier from relay to human-readable duration
const formatDurationFromRelay = (unit: string, multiplier = 1): string => {
  const periodLabels: Record<string, string> = {
    minute: 'Minute',
    hour: 'Hour',
    day: 'Day',
    week: 'Week',
    month: 'Month',
    year: 'Year',
    forever: 'Forever',
  };

  const label = periodLabels[unit] || unit;

  // Forever doesn't need a multiplier
  if (unit === 'forever') {
    return 'Forever';
  }

  // Add 's' for plural when multiplier > 1
  const pluralSuffix = multiplier > 1 ? 's' : '';
  return `${multiplier} ${label}${pluralSuffix}`;
};

// Format timestamp to readable date
const formatExpiryDate = (timestamp: number): string => {
  const date = new Date(timestamp * 1000); // Convert to milliseconds
  return date.toLocaleString('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

// Token info cache type
// `decimals: null` means the token's `decimals()` read failed — kept distinct from a number so a
// failed read can never be mistaken for 18. See formatSpendAmount.
type TokenInfoMap = Record<string, { decimals: number | null; symbol: string }>;

export const PermissionModal = ({
  permissionRequest,
  chain,
  apiKey,
  origin,
  appName,
  appLogoUrl,
  onSuccess,
  onError,
}: PermissionModalProps) => {
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
  // Synchronous re-entry guard: isProcessing disables the buttons only after a
  // re-render, which is too soft a gate for a grant that delegates authority on-chain.
  const submittingRef = useRef(false);
  const [tokenInfoMap, setTokenInfoMap] = useState<TokenInfoMap>({});
  const [isLoadingTokenInfo, setIsLoadingTokenInfo] = useState<boolean>(true); // Start true to prevent early clicks
  const [feeTokens, setFeeTokens] = useState<FeeTokenOption[]>([]);
  const [feeTokensLoading, setFeeTokensLoading] = useState<boolean>(true);

  // Extract API key from rpcUrl if not provided as prop
  const extractedApiKey = useMemo(() => {
    if (apiKey) return apiKey;

    if (chain?.rpcUrl) {
      try {
        const url = new URL(chain.rpcUrl);
        return url.searchParams.get('api-key') || '';
      } catch (error) {
        console.error('Failed to parse rpcUrl:', error);
        return '';
      }
    }

    return '';
  }, [apiKey, chain?.rpcUrl]);

  // Note: Account initialization is handled by useSessionAccount hook

  // Compute mainnet RPC URL for JustaName SDK (ENS resolution)
  const mainnetRpcUrl = useMemo(() => {
    return extractedApiKey ? `${JAW_RPC_URL}?chainId=1&api-key=${extractedApiKey}` : `${JAW_RPC_URL}?chainId=1`;
  }, [extractedApiKey]);

  // Determine mode from request method
  const mode = useMemo(() => {
    if (!permissionRequest) return 'grant';
    return permissionRequest.method === 'wallet_grantPermissions' ? 'grant' : 'revoke';
  }, [permissionRequest]);

  // Extract paymasterUrl from capabilities (EIP-5792 paymasterService capability)
  // Priority: capabilities.paymasterService.url > chain.paymaster.url
  const effectivePaymasterUrl = useMemo(() => {
    if (!permissionRequest) return chain?.paymaster?.url;

    const params = permissionRequest.params[0];
    const capabilitiesPaymasterUrl = params?.capabilities?.paymasterService?.url;
    return capabilitiesPaymasterUrl || chain?.paymaster?.url;
  }, [permissionRequest, chain?.paymaster?.url]);

  // Extract paymasterContext from capabilities (for ERC-20 token payments, mode flags, etc.)
  // Priority: capabilities.paymasterService.context > chain.paymaster.context
  const effectivePaymasterContext = useMemo(() => {
    if (!permissionRequest) return chain?.paymaster?.context;

    const params = permissionRequest.params[0];
    const capabilitiesPaymasterContext = (
      params?.capabilities?.paymasterService as { context?: Record<string, unknown> } | undefined
    )?.context;
    return capabilitiesPaymasterContext || chain?.paymaster?.context;
  }, [permissionRequest, chain?.paymaster?.context]);

  // Get viem chain for fee token fetching
  const viemChain = useMemo(() => {
    if (!chain?.id) return null;
    return SUPPORTED_CHAINS.find((c) => c.id === chain.id);
  }, [chain?.id]);

  // Check if this is a sponsored transaction (paymaster provided)
  const isSponsored = !!effectivePaymasterUrl;

  // Extract permission details from request (needed before gas estimation for address override)
  const permissionDetails = useMemo(() => {
    if (!permissionRequest) return null;

    if (mode === 'grant') {
      const params = permissionRequest.params as WalletGrantPermissionsRequest['params'];
      const [grantParams] = params;

      return {
        spender: grantParams.spender,
        expiry: grantParams.expiry,
        spends: grantParams.permissions.spends || [],
        calls: grantParams.permissions.calls || [],
        address: grantParams.address,
        // The spender sends every op this permission authorises, and the ERC-20
        // paymaster charges the sender, so its first one has nothing to be
        // charged. The SDK rides a small transfer along in this transaction when
        // the request asks; it decides the amount and the destination, not the
        // requester. Not rendered: like the paymaster's own approval, it is part
        // of what this transaction costs rather than part of what it authorises.
        prefundSpender: grantParams.capabilities?.prefundSpender === true,
      };
    } else {
      const params = permissionRequest.params as WalletRevokePermissionsRequest['params'];
      const [revokeParams] = params;

      return {
        permissionId: revokeParams.id,
        address: revokeParams.address,
      };
    }
  }, [permissionRequest, mode]);

  // Owns the relay fetch, the 404-vs-transport split and the validation, shared with the SDK's own
  // handler so both revoke screens read the same `from`. `permissionDetails?.address` is the
  // request's own account: the bare connected wallet reports `not-granter` whenever a request names
  // another account this passkey owns, which blocks a legitimate revocation.
  const {
    permission: fetchedPermissionData,
    // Feeds the Confirm gate alongside the token-info flag below, exactly as the local state it
    // replaced did — the permission and its token metadata must both land before signing.
    loading: isLoadingPermissionDetails,
    problem: revocationProblem,
  } = usePermissionRevocation({
    permissionId:
      permissionDetails && 'permissionId' in permissionDetails
        ? (permissionDetails.permissionId as `0x${string}`)
        : undefined,
    apiKey: extractedApiKey,
    chainId: chain?.id,
    from: (permissionDetails?.address ?? walletAddress ?? undefined) as `0x${string}` | undefined,
    enabled: mode === 'revoke',
  });

  // Build the actual permission call for gas estimation (grant or revoke)
  const transactionCalls = useMemo(() => {
    if (mode === 'grant') {
      // Grant mode: build grant permission call
      // Use override address if provided, otherwise fall back to connected wallet address
      const params = permissionRequest?.params as WalletGrantPermissionsRequest['params'] | undefined;
      const grantParams = params?.[0];
      const targetAddress = grantParams?.address ?? walletAddress;
      if (!targetAddress || !permissionRequest) return [];

      try {
        const permissionCall = buildGrantPermissionCall(
          targetAddress as Address,
          grantParams!.spender as Address,
          grantParams!.expiry,
          grantParams!.permissions
        );
        return [permissionCall];
      } catch (error) {
        console.warn('[PermissionModal] Failed to build permission grant call:', error);
        return [];
      }
    } else {
      // Revoke mode: build revoke permission call using fetched permission data
      if (!fetchedPermissionData) return [];

      try {
        const revokeCall = buildRevokePermissionCall(fetchedPermissionData);
        return [revokeCall];
      } catch (error) {
        console.warn('[PermissionModal] Failed to build permission revoke call:', error);
        return [];
      }
    }
  }, [mode, walletAddress, permissionRequest, fetchedPermissionData]);

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
    chainId: chain?.id || 1,
    apiKey: extractedApiKey,
    feeTokens,
    isSponsored,
    address: permissionDetails?.address as Address | undefined,
    onFeeTokensUpdate: setFeeTokens,
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
      return jawPaymasterUrl(chain.id, extractedApiKey);
    }

    // Native ETH - no paymaster needed
    return undefined;
  }, [effectivePaymasterUrl, selectedFeeToken, chain?.id, extractedApiKey]);

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

  // Network name and icon
  const networkName = useMemo(() => {
    const chainId = chain?.id;
    if (!chainId) return 'Ethereum Mainnet';
    return getChainNameFromId(chainId);
  }, [chain]);

  // Get spends array based on mode
  const spendsData = useMemo(() => {
    if (mode === 'revoke' && fetchedPermissionData?.spends) {
      return fetchedPermissionData.spends;
    }
    if (mode === 'grant' && permissionDetails && 'spends' in permissionDetails) {
      return permissionDetails.spends ?? [];
    }
    return [];
  }, [mode, fetchedPermissionData, permissionDetails]);

  /** Unix seconds the permission being granted ends at, which is what a total is measured to. */
  const grantExpiry = useMemo(() => {
    if (mode !== 'grant' || !permissionDetails || !('expiry' in permissionDetails)) return undefined;
    const expiry = Number(permissionDetails.expiry);
    return Number.isFinite(expiry) && expiry > 0 ? expiry : undefined;
  }, [mode, permissionDetails]);

  // Get calls array based on mode
  const callsData = useMemo(() => {
    if (mode === 'revoke' && fetchedPermissionData?.calls) {
      return fetchedPermissionData.calls;
    }
    if (mode === 'grant' && permissionDetails && 'calls' in permissionDetails) {
      return permissionDetails.calls ?? [];
    }
    return [];
  }, [mode, fetchedPermissionData, permissionDetails]);

  // Format spend permissions with token info
  const formattedSpends = useMemo(() => {
    return spendsData.map((spend: any) => {
      const tokenAddress = spend.token;
      // No symbol until it resolves — a placeholder here would label every token "ETH". Only a
      // native token has decimals knowable without a read.
      const tokenInfo = tokenInfoMap[tokenAddress] || {
        decimals: isNativeToken(tokenAddress) ? (viemChain?.nativeCurrency?.decimals ?? 18) : null,
        symbol: isNativeToken(tokenAddress) ? (viemChain?.nativeCurrency?.symbol ?? 'ETH') : '',
      };

      // allowance is a hex string from the relay, a decimal string from a grant request; BigInt
      // reads both. Only the duration formatting differs by mode.
      const allowance = BigInt(spend.allowance);
      const { amount, decimalsUnknown } = formatSpendAmount(allowance, tokenInfo.decimals);
      const limit = decimalsUnknown ? `${amount} base units` : `${amount} ${tokenInfo.symbol}`;
      const duration =
        mode === 'revoke'
          ? formatDurationFromRelay(spend.unit, spend.multiplier ?? 1)
          : formatDuration(spend.unit as SpendPeriod, spend.multiplier ?? 1);

      // Grant only: what approving this rate costs by the time the permission
      // expires. The row leads with the rate, and the rate is not what is being
      // approved, which is how a permission asking for a million rendered as
      // tidily as one asking for ten. A revoke is about a permission that already
      // exists, so its remaining exposure is a different question.
      const exposure =
        mode === 'grant' && grantExpiry
          ? spendExposure({
              allowance,
              unit: spend.unit,
              multiplier: spend.multiplier ?? 1,
              expiry: grantExpiry,
              now: Math.floor(Date.now() / 1000),
            })
          : null;

      return {
        amount,
        decimalsUnknown,
        // Nothing to add when the total only repeats the rate, as a single-window
        // grant and a `forever` limit both do.
        total:
          exposure && exposure.periods > 1 ? formatSpendAmount(exposure.total, tokenInfo.decimals).amount : undefined,
        token: isNativeToken(tokenAddress)
          ? 'Native (ETH)'
          : tokenInfo.symbol === tokenAddress
            ? `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`
            : tokenInfo.symbol,
        tokenAddress,
        duration,
        limit,
      };
    });
  }, [spendsData, tokenInfoMap, mode, grantExpiry]);

  // Format call permissions
  // Signatures resolve asynchronously — an unresolved selector renders as raw hex, then upgrades.
  const callSignatures = useFunctionSignatures(callsData.map((call: any) => call.selector));
  const formattedCalls = useMemo(() => {
    return callsData.map((call: any) => ({
      target: call.target,
      selector: call.selector,
      functionSignature:
        call.functionSignature ||
        (call.selector ? (callSignatures[call.selector.toLowerCase()] ?? call.selector) : 'Unknown Function'),
    }));
  }, [callsData, callSignatures]);

  // Grant date (revoke only) — the stored permission's `start`, mirroring how expiry uses `end`.
  const grantedDate = useMemo(() => {
    if (mode !== 'revoke' || !fetchedPermissionData?.start) return undefined;
    return formatExpiryDate(Number(fetchedPermissionData.start));
  }, [mode, fetchedPermissionData]);

  // Expiry date
  const expiryDate = useMemo(() => {
    if (!permissionDetails) return '';

    if (mode === 'revoke' && fetchedPermissionData) {
      const endTimestamp = Number(fetchedPermissionData.end);
      return formatExpiryDate(endTimestamp);
    }

    if ('expiry' in permissionDetails && permissionDetails.expiry) {
      return formatExpiryDate(permissionDetails.expiry);
    }

    return '';
  }, [permissionDetails, mode, fetchedPermissionData]);

  // Spender address
  const spenderAddress = useMemo(() => {
    if (mode === 'revoke' && fetchedPermissionData?.spender) {
      return fetchedPermissionData.spender;
    }

    if (permissionDetails && 'spender' in permissionDetails && permissionDetails.spender) {
      return permissionDetails.spender;
    }

    return '0x43e...ead3';
  }, [mode, fetchedPermissionData, permissionDetails]);

  // Generate warning message based on actual permissions
  // Reset state
  const resetModalState = useCallback(() => {
    setStatus('');
    setIsProcessing(false);
  }, []);

  useEffect(() => {
    if (!chain) {
      resetModalState();
    }
  }, [chain, resetModalState]);

  // Fetch fee tokens (ETH + available ERC-20 tokens from chain config)
  useEffect(() => {
    // Use override address for balance fetching when operating on behalf of another account
    const balanceAddress = permissionDetails?.address ?? walletAddress;
    // Skip if already sponsored via capabilities or config, or missing required data
    if (effectivePaymasterUrl || !chain || !balanceAddress) {
      setFeeTokensLoading(false);
      return;
    }

    let isMounted = true;

    const fetchFeeTokensData = async () => {
      if (!viemChain || !extractedApiKey) {
        setFeeTokensLoading(false);
        return;
      }

      try {
        setFeeTokensLoading(true);

        // Fetch capabilities from JAW RPC
        const capabilities = await handleGetCapabilitiesRequest(
          { method: 'wallet_getCapabilities', params: [] },
          extractedApiKey || '',
          true // showTestnets
        );

        const chainIdHex = `0x${(chain?.id || 1).toString(16)}` as `0x${string}`;
        const feeTokenCap = capabilities?.[chainIdHex]?.feeToken;

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
              const balance = await fetchTokenBalance(token.address, balanceAddress, rpcUrl, chain?.id);
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
        console.warn('[PermissionModal] Failed to fetch fee tokens:', error);
      } finally {
        if (isMounted) setFeeTokensLoading(false);
      }
    };

    fetchFeeTokensData();

    return () => {
      isMounted = false;
    };
  }, [chain, extractedApiKey, viemChain, walletAddress, permissionDetails?.address, effectivePaymasterUrl]);

  // Token info for spend tokens and for any call target that turns out to be a token.
  useEffect(() => {
    // Bail rather than passing an empty URL down: getPublicClient attaches the chain
    // definition, so an empty URL would resolve to the chain's public RPC instead of the
    // proxy — and it throws, which this fire-and-forget async fn would not catch.
    const rpcUrl = chain?.rpcUrl;
    if (!chain || !rpcUrl || (spendsData.length === 0 && callsData.length === 0)) {
      setIsLoadingTokenInfo(false);
      return;
    }

    let isMounted = true;
    setIsLoadingTokenInfo(true);

    const fetchAllTokenInfo = async () => {
      const newTokenInfoMap: TokenInfoMap = {};

      // Get unique token addresses
      // A call target that is a token should read as "USDC", not as a raw address. A non-token
      // contract simply fails the reads and falls back to its address.
      const uniqueTokens = Array.from(
        new Set([
          ...spendsData.map((spend: any) => spend.token as string),
          ...callsData.map((call: any) => call.target as string).filter((t: string) => t && !isWildcard(t)),
        ])
      ) as string[];

      // Resolved in one pass rather than token-by-token: the shared client folds every
      // decimals/symbol read issued in this tick into a single Multicall3 request, so N
      // tokens cost one round-trip instead of 2N sequential ones.
      const publicClient = getPublicClient(chain.id, rpcUrl);

      const pending: string[] = [];
      for (const tokenAddress of uniqueTokens) {
        if (tokenInfoMap[tokenAddress]) {
          newTokenInfoMap[tokenAddress] = tokenInfoMap[tokenAddress];
        } else if (isNativeToken(tokenAddress)) {
          // Native token: the chain's own currency, not a hardcoded ETH.
          newTokenInfoMap[tokenAddress] = {
            decimals: viemChain?.nativeCurrency?.decimals ?? 18,
            symbol: viemChain?.nativeCurrency?.symbol ?? 'ETH',
          };
        } else {
          pending.push(tokenAddress);
        }
      }

      await Promise.all(
        pending.map(async (tokenAddress) => {
          try {
            const [decimals, symbol] = await Promise.all([
              publicClient.readContract({ address: tokenAddress as Address, abi: erc20Abi, functionName: 'decimals' }),
              publicClient.readContract({ address: tokenAddress as Address, abi: erc20Abi, functionName: 'symbol' }),
            ]);
            newTokenInfoMap[tokenAddress] = { decimals, symbol };
          } catch {
            // Not an ERC-20 (or unreachable) — unnamed, so the UI shows the address.
            newTokenInfoMap[tokenAddress] = { decimals: null, symbol: '' };
          }
        })
      );

      if (isMounted) {
        setTokenInfoMap((prev) => ({ ...prev, ...newTokenInfoMap }));
        setIsLoadingTokenInfo(false);
      }
    };

    fetchAllTokenInfo();

    return () => {
      isMounted = false;
    };
    // tokenInfoMap is read for its cache but deliberately not a dep — the effect writes it,
    // so listing it would loop. Everything else the body reads is here.
  }, [chain, spendsData, callsData, viemChain]);

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      setIsProcessing(true);
      setStatus(mode === 'grant' ? 'Granting permissions...' : 'Revoking permission...');

      if (!account) {
        throw new Error('Account not initialized. Please try again.');
      }

      if (!chain) {
        throw new Error('Chain information is required.');
      }

      if (!permissionDetails) {
        throw new Error('Permission details are missing.');
      }

      // effectivePaymasterUrl is extracted from capabilities or chain config via useMemo above

      if (mode === 'grant') {
        if (!('expiry' in permissionDetails) || !('spender' in permissionDetails)) {
          throw new Error('Invalid grant permission parameters.');
        }

        if (!permissionDetails.expiry) {
          throw new Error('Expiry is required for granting permissions.');
        }

        if (!permissionDetails.spender) {
          throw new Error('Spender is required for granting permissions.');
        }

        // Account.grantPermissions with paymaster URL and context for ERC-20 payment
        const result = await account.grantPermissions(
          permissionDetails.expiry,
          permissionDetails.spender,
          {
            spends: permissionDetails.spends,
            calls: permissionDetails.calls,
          },
          computedPaymasterUrl,
          computedPaymasterContext,
          permissionDetails.address,
          { prefundSpender: 'prefundSpender' in permissionDetails && permissionDetails.prefundSpender }
        );

        console.log('Permissions granted:', result);
        setStatus('Permissions granted successfully!');
        onSuccess?.(result);
      } else {
        // Revoke mode
        if (!('permissionId' in permissionDetails)) {
          throw new Error('Permission ID is required for revoke.');
        }

        if (!permissionDetails.permissionId) {
          throw new Error('Permission ID is missing.');
        }

        // Account.revokePermission with paymaster URL and context for ERC-20 payment
        await account.revokePermission(
          permissionDetails.permissionId,
          computedPaymasterUrl,
          computedPaymasterContext,
          permissionDetails.address
        );

        console.log('Permission revoked');
        setStatus('Permission revoked successfully!');
        onSuccess?.({ success: true });
      }
    } catch (error) {
      console.error('Error in permission operation:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus(`Error: ${errorMessage}`);
      const errorObj = error instanceof Error ? error : new Error(errorMessage);
      // Check if user cancelled passkey prompt (NotAllowedError)
      const errorCode =
        error instanceof Error && error.name === 'NotAllowedError'
          ? standardErrorCodes.provider.userRejectedRequest
          : standardErrorCodes.rpc.internal;
      onError?.(errorObj, errorCode);
      submittingRef.current = false;
      setIsProcessing(false);
    }
  }, [account, chain, permissionDetails, mode, onSuccess, onError, computedPaymasterUrl, computedPaymasterContext]);

  const handleCancel = useCallback(() => {
    // isProcessing commits a render late; a same-tick cancel must not report
    // "rejected" while the signed grant/revocation proceeds and lands on chain.
    if (submittingRef.current) return;
    if (!isProcessing) {
      console.log('❌ User cancelled permission request');
      // User rejected request (EIP-1193 code 4001)
      onError?.(new Error('User rejected the request'), standardErrorCodes.provider.userRejectedRequest);
      setStatus('');
      // Reset fee token state
      setFeeTokens([]);
      setSelectedFeeToken(null);
    }
  }, [isProcessing, onError, setSelectedFeeToken]);

  // Don't render if no permission details
  if (!permissionDetails) {
    return null;
  }

  return (
    <PermissionDialog
      open={true}
      onOpenChange={() => {
        console.log('onOpenChange');
      }}
      mode={mode}
      permissionId={
        mode === 'revoke' && 'permissionId' in permissionDetails ? permissionDetails.permissionId : undefined
      }
      revocationProblem={revocationProblem}
      spenderAddress={spenderAddress}
      accountAddress={walletAddress || undefined}
      origin={origin || ''}
      appName={appName}
      appLogoUrl={appLogoUrl}
      grantedDate={grantedDate}
      spends={formattedSpends}
      tokenMeta={tokenInfoMap}
      calls={formattedCalls}
      expiryDate={expiryDate}
      networkName={networkName}
      chainId={chain?.id}
      apiKey={extractedApiKey}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      isProcessing={isProcessing}
      status={status}
      isLoadingTokenInfo={isLoadingTokenInfo || isLoadingPermissionDetails || isAccountLoading}
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
    />
  );
};
