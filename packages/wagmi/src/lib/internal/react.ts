'use client';

import { useEffect, useMemo, useRef } from 'react';
import { type Config, type ResolvedRegister, useAccount, useChainId, useConfig, useConnectors } from 'wagmi';
import { type UseMutationParameters, type UseQueryParameters, type UseQueryReturnType } from 'wagmi/query';
import { type UseMutationResult, useMutation, useQuery, useQueryClient, skipToken } from '@tanstack/react-query';
import type { EIP1193Provider } from 'viem';
import {
  connect,
  disconnect,
  grantPermissions,
  getPermissions,
  revokePermissions,
  getAssets,
  getCapabilities,
  sign,
  getCallsHistory,
  addFunds,
} from './core.js';
import {
  getPermissionsQueryKey,
  getAssetsQueryKey,
  getCapabilitiesQueryKey,
  getCallsHistoryQueryKey,
} from './query.js';

// ============================================================================
// useConnect
// ============================================================================

export namespace useConnect {
  export type Parameters<config extends Config = Config, context = unknown> = {
    config?: config;
    mutation?: UseMutationParameters<connect.ReturnType, connect.ErrorType, connect.Parameters, context> | undefined;
  };

  export type ReturnType<context = unknown> = UseMutationResult<
    connect.ReturnType,
    connect.ErrorType,
    connect.Parameters,
    context
  >;
}

/**
 * Hook to connect to the wallet with optional capabilities.
 *
 * @example
 * ```tsx
 * const { mutate, data, isPending } = useConnect();
 *
 * // Basic connect
 * mutate({ connector: jawWallet({ apiKey: 'xxx' }) });
 *
 * // Connect with capabilities (subname issuance)
 * mutate({
 *   connector: jawWallet({ apiKey: 'xxx' }),
 *   capabilities: {
 *     subnameTextRecords: [
 *       { key: 'avatar', value: 'https://example.com/avatar.png' },
 *     ],
 *   },
 * });
 * ```
 */
export function useConnect<config extends Config = ResolvedRegister['config'], context = unknown>(
  parameters: useConnect.Parameters<config, context> = {}
): useConnect.ReturnType<context> {
  const { mutation } = parameters;
  const config = useConfig(parameters as { config?: Config });

  return useMutation({
    ...mutation,
    mutationFn: async (variables) => {
      return connect(config, variables);
    },
    mutationKey: ['connect'],
  }) as useConnect.ReturnType<context>;
}

// ============================================================================
// useGrantPermissions
// ============================================================================

export namespace useGrantPermissions {
  export type Parameters<config extends Config = Config, context = unknown> = {
    config?: config;
    mutation?:
      | UseMutationParameters<
          grantPermissions.ReturnType,
          grantPermissions.ErrorType,
          grantPermissions.Parameters<config>,
          context
        >
      | undefined;
  };

  export type ReturnType<config extends Config = Config, context = unknown> = UseMutationResult<
    grantPermissions.ReturnType,
    grantPermissions.ErrorType,
    grantPermissions.Parameters<config>,
    context
  >;
}

/**
 * Hook to grant permissions to a spender address.
 *
 * @example
 * ```tsx
 * const { mutate, data, isPending } = useGrantPermissions();
 *
 * mutate({
 *   expiry: Math.floor(Date.now() / 1000) + 3600, // 1 hour
 *   spender: '0x...',
 *   permissions: {
 *     calls: [{ target: '0x...', functionSignature: 'transfer(address,uint256)' }],
 *     spends: [{ token: '0x...', allowance: '1000000000000000000', unit: 'hour', multiplier: 1 }],
 *   },
 * });
 * ```
 */
export function useGrantPermissions<config extends Config = ResolvedRegister['config'], context = unknown>(
  parameters: useGrantPermissions.Parameters<config, context> = {}
): useGrantPermissions.ReturnType<config, context> {
  const { mutation } = parameters;
  const config = useConfig(parameters as { config?: Config });

  return useMutation({
    ...mutation,
    mutationFn: async (variables) => {
      return grantPermissions(config, variables);
    },
    mutationKey: ['grantPermissions'],
  }) as useGrantPermissions.ReturnType<config, context>;
}

// ============================================================================
// useRevokePermissions
// ============================================================================

export namespace useRevokePermissions {
  export type Parameters<config extends Config = Config, context = unknown> = {
    config?: config;
    mutation?:
      | UseMutationParameters<
          revokePermissions.ReturnType,
          revokePermissions.ErrorType,
          revokePermissions.Parameters<config>,
          context
        >
      | undefined;
  };

  export type ReturnType<config extends Config = Config, context = unknown> = UseMutationResult<
    revokePermissions.ReturnType,
    revokePermissions.ErrorType,
    revokePermissions.Parameters<config>,
    context
  >;
}

/**
 * Hook to revoke a permission by its ID.
 *
 * @example
 * ```tsx
 * const { mutate, isPending } = useRevokePermissions();
 *
 * mutate({
 *   id: '0x...', // permission hash
 * });
 * ```
 */
export function useRevokePermissions<config extends Config = ResolvedRegister['config'], context = unknown>(
  parameters: useRevokePermissions.Parameters<config, context> = {}
): useRevokePermissions.ReturnType<config, context> {
  const { mutation } = parameters;
  const config = useConfig(parameters as { config?: Config });

  return useMutation({
    ...mutation,
    mutationFn: async (variables) => {
      return revokePermissions(config, variables);
    },
    mutationKey: ['revokePermissions'],
  }) as useRevokePermissions.ReturnType<config, context>;
}

// ============================================================================
// usePermissions
// ============================================================================

export namespace usePermissions {
  export type Parameters<
    config extends Config = Config,
    selectData = getPermissions.ReturnType,
  > = getPermissions.Parameters<config> & {
    config?: config;
    query?:
      | Omit<
          UseQueryParameters<
            getPermissions.ReturnType,
            getPermissions.ErrorType,
            selectData,
            getPermissionsQueryKey.Value<config>
          >,
          'gcTime' | 'staleTime'
        >
      | undefined;
  };

  export type ReturnType<selectData = getPermissions.ReturnType> = UseQueryReturnType<
    selectData,
    getPermissions.ErrorType
  >;
}

/**
 * Hook to get the current permissions for an account.
 * Automatically updates when permissions change.
 *
 * @example
 * ```tsx
 * const { data: permissions, isLoading } = usePermissions();
 *
 * // With specific address (works even when not connected)
 * const { data } = usePermissions({ address: '0x...' });
 * ```
 */
export function usePermissions<
  config extends Config = ResolvedRegister['config'],
  selectData = getPermissions.ReturnType,
>(parameters: usePermissions.Parameters<config, selectData> = {}): usePermissions.ReturnType<selectData> {
  const { query = {}, ...rest } = parameters;

  const config = useConfig(rest as { config?: Config });
  const queryClient = useQueryClient();
  const chainId = useChainId({ config });
  const { address: connectedAddress, connector, status } = useAccount({ config });
  const connectors = useConnectors({ config });
  // Use account connector if connected, otherwise find JAW connector from available connectors
  const jawConnector = connectors.find((c) => c.id === 'jaw');
  const activeConnector = parameters.connector ?? connector ?? jawConnector;

  // Use explicit address if provided, otherwise fall back to connected address
  const targetAddress = parameters.address ?? connectedAddress;

  // Enable query if:
  // 1. Connected (existing behavior), OR
  // 2. Explicit address provided AND connector available (disconnected query)
  const isConnected = status === 'connected' || (status === 'reconnecting' && activeConnector?.getProvider);
  const canQueryDisconnected = Boolean(targetAddress && activeConnector?.getProvider);

  const enabled = Boolean((isConnected || canQueryDisconnected) && (query.enabled ?? true));

  const queryKey = useMemo(
    () =>
      getPermissionsQueryKey({
        address: targetAddress,
        chainId: parameters.chainId ?? chainId,
        connector: activeConnector,
      }),
    [targetAddress, chainId, parameters.chainId, activeConnector]
  );

  // Set up event listener for permission changes
  const providerRef = useRef<EIP1193Provider | undefined>(undefined);
  const handlerRef = useRef<((event: { type: string }) => void) | undefined>(undefined);

  useEffect(() => {
    if (!activeConnector) return;

    let mounted = true;

    void (async () => {
      const provider = (await activeConnector.getProvider?.()) as EIP1193Provider | undefined;
      if (!mounted || !provider) return;

      providerRef.current = provider;

      const handleMessage = (event: { type: string }) => {
        if (event.type !== 'permissionsChanged') return;
        queryClient.invalidateQueries({ queryKey });
      };

      handlerRef.current = handleMessage;
      provider.on('message', handleMessage as never);
    })();

    return () => {
      mounted = false;
      if (providerRef.current && handlerRef.current) {
        providerRef.current.removeListener?.('message', handlerRef.current as never);
      }
    };
  }, [activeConnector, queryClient, queryKey]);

  return useQuery({
    ...query,
    enabled,
    gcTime: 0,
    queryFn: activeConnector
      ? async () => {
          // When connected, use the standard flow
          if (isConnected) {
            return getPermissions(config, {
              ...rest,
              connector: activeConnector,
            });
          }
          // When disconnected but have address, make direct provider call
          const provider = (await activeConnector.getProvider?.()) as EIP1193Provider | undefined;
          if (!provider) throw new Error('Provider not available');
          if (!targetAddress) throw new Error('Address is required when not connected');

          return provider.request({
            method: 'wallet_getPermissions' as never,
            params: [{ address: targetAddress }] as never,
          }) as Promise<getPermissions.ReturnType>;
        }
      : skipToken,
    queryKey,
    staleTime: Number.POSITIVE_INFINITY,
  }) as usePermissions.ReturnType<selectData>;
}

// ============================================================================
// useDisconnect
// ============================================================================

export namespace useDisconnect {
  export type Parameters<config extends Config = Config, context = unknown> = {
    config?: config;
    mutation?:
      | UseMutationParameters<disconnect.ReturnType, disconnect.ErrorType, disconnect.Parameters, context>
      | undefined;
  };

  export type ReturnType<context = unknown> = UseMutationResult<
    disconnect.ReturnType,
    disconnect.ErrorType,
    disconnect.Parameters,
    context
  >;
}

/**
 * Hook to disconnect from the wallet.
 *
 * @example
 * ```tsx
 * const { mutate: disconnectWallet, isPending } = useDisconnect();
 *
 * // Disconnect active connector
 * disconnectWallet({});
 *
 * // Disconnect specific connector
 * disconnectWallet({ connector: jawWallet({ apiKey: 'xxx' }) });
 * ```
 */
export function useDisconnect<config extends Config = ResolvedRegister['config'], context = unknown>(
  parameters: useDisconnect.Parameters<config, context> = {}
): useDisconnect.ReturnType<context> {
  const { mutation } = parameters;
  const config = useConfig(parameters as { config?: Config });

  return useMutation({
    ...mutation,
    mutationFn: async (variables) => {
      return disconnect(config, variables);
    },
    mutationKey: ['disconnect'],
  }) as useDisconnect.ReturnType<context>;
}

// ============================================================================
// useGetAssets
// ============================================================================

export namespace useGetAssets {
  export type Parameters<
    config extends Config = Config,
    selectData = getAssets.ReturnType,
  > = getAssets.Parameters<config> & {
    config?: config;
    query?:
      | Omit<
          UseQueryParameters<getAssets.ReturnType, getAssets.ErrorType, selectData, getAssetsQueryKey.Value<config>>,
          'gcTime' | 'staleTime'
        >
      | undefined;
  };

  export type ReturnType<selectData = getAssets.ReturnType> = UseQueryReturnType<selectData, getAssets.ErrorType>;
}

/**
 * Hook to get the assets for an account.
 * Automatically updates when assets change.
 *
 * @example
 * ```tsx
 * const { data: assets, isLoading } = useGetAssets();
 *
 * // With specific address (works even when not connected)
 * const { data } = useGetAssets({ address: '0x...' });
 *
 * // With chain filter
 * const { data } = useGetAssets({ chainFilter: ['0x1', '0xa'] });
 *
 * // With asset type filter
 * const { data } = useGetAssets({ assetTypeFilter: ['erc20'] });
 * ```
 */
export function useGetAssets<config extends Config = ResolvedRegister['config'], selectData = getAssets.ReturnType>(
  parameters: useGetAssets.Parameters<config, selectData> = {}
): useGetAssets.ReturnType<selectData> {
  const { query = {}, ...rest } = parameters;

  const config = useConfig(rest as { config?: Config });
  const queryClient = useQueryClient();
  const chainId = useChainId({ config });
  const { address: connectedAddress, connector, status } = useAccount({ config });
  const connectors = useConnectors({ config });
  // Use account connector if connected, otherwise find JAW connector from available connectors
  const jawConnector = connectors.find((c) => c.id === 'jaw');
  const activeConnector = parameters.connector ?? connector ?? jawConnector;

  // Use explicit address if provided, otherwise fall back to connected address
  const targetAddress = parameters.address ?? connectedAddress;

  // Enable query if:
  // 1. Connected (existing behavior), OR
  // 2. Explicit address provided AND connector available (disconnected query)
  const isConnected = status === 'connected' || (status === 'reconnecting' && activeConnector?.getProvider);
  const canQueryDisconnected = Boolean(targetAddress && activeConnector?.getProvider);

  const enabled = Boolean((isConnected || canQueryDisconnected) && (query.enabled ?? true));

  const queryKey = useMemo(
    () =>
      getAssetsQueryKey({
        address: targetAddress,
        chainId: parameters.chainId ?? chainId,
        connector: activeConnector,
        chainFilter: parameters.chainFilter,
        assetTypeFilter: parameters.assetTypeFilter,
        assetFilter: parameters.assetFilter,
      }),
    [
      targetAddress,
      chainId,
      parameters.chainId,
      activeConnector,
      parameters.chainFilter,
      parameters.assetTypeFilter,
      parameters.assetFilter,
    ]
  );

  // Set up event listener for asset changes (e.g., after transactions)
  const providerRef = useRef<EIP1193Provider | undefined>(undefined);
  const handlerRef = useRef<((event: { type: string }) => void) | undefined>(undefined);

  useEffect(() => {
    if (!activeConnector) return;

    let mounted = true;

    void (async () => {
      const provider = (await activeConnector.getProvider?.()) as EIP1193Provider | undefined;
      if (!mounted || !provider) return;

      providerRef.current = provider;

      const handleMessage = (event: { type: string }) => {
        if (event.type !== 'assetsChanged') return;
        queryClient.invalidateQueries({ queryKey });
      };

      handlerRef.current = handleMessage;
      provider.on('message', handleMessage as never);
    })();

    return () => {
      mounted = false;
      if (providerRef.current && handlerRef.current) {
        providerRef.current.removeListener?.('message', handlerRef.current as never);
      }
    };
  }, [activeConnector, queryClient, queryKey]);

  return useQuery({
    ...query,
    enabled,
    gcTime: 0,
    queryFn: activeConnector
      ? async () => {
          // When connected, use the standard flow
          if (isConnected) {
            return getAssets(config, {
              ...rest,
              address: targetAddress,
              connector: activeConnector,
            });
          }
          // When disconnected but have address, make direct provider call
          const provider = (await activeConnector.getProvider?.()) as EIP1193Provider | undefined;
          if (!provider) throw new Error('Provider not available');
          if (!targetAddress) throw new Error('Address is required when not connected');

          return provider.request({
            method: 'wallet_getAssets' as never,
            params: [
              {
                account: targetAddress,
                chainFilter: parameters.chainFilter,
                assetTypeFilter: parameters.assetTypeFilter,
                assetFilter: parameters.assetFilter,
              },
            ] as never,
          }) as Promise<getAssets.ReturnType>;
        }
      : skipToken,
    queryKey,
    staleTime: 30_000, // Cache for 30 seconds since assets change less frequently
  }) as useGetAssets.ReturnType<selectData>;
}

// ============================================================================
// useCapabilities
// ============================================================================

export namespace useCapabilities {
  export type Parameters<
    config extends Config = Config,
    selectData = getCapabilities.ReturnType,
  > = getCapabilities.Parameters<config> & {
    config?: config;
    query?:
      | Omit<
          UseQueryParameters<
            getCapabilities.ReturnType,
            getCapabilities.ErrorType,
            selectData,
            getCapabilitiesQueryKey.Value<config>
          >,
          'gcTime' | 'staleTime'
        >
      | undefined;
  };

  export type ReturnType<selectData = getCapabilities.ReturnType> = UseQueryReturnType<
    selectData,
    getCapabilities.ErrorType
  >;
}

/**
 * Hook to get the wallet capabilities (EIP-5792).
 * Can be called without a connected account.
 *
 * @example
 * ```tsx
 * // Get capabilities (uses connected account if available)
 * const { data: capabilities, isLoading } = useCapabilities();
 *
 * // With specific address (works even when not connected)
 * const { data } = useCapabilities({ address: '0x...' });
 *
 * // With chain filter
 * const { data } = useCapabilities({ chainFilter: ['0x1', '0xa'] });
 * ```
 */
export function useCapabilities<
  config extends Config = ResolvedRegister['config'],
  selectData = getCapabilities.ReturnType,
>(parameters: useCapabilities.Parameters<config, selectData> = {}): useCapabilities.ReturnType<selectData> {
  const { query = {}, ...rest } = parameters;

  const config = useConfig(rest as { config?: Config });
  const chainId = useChainId({ config });
  const { address: connectedAddress, connector, status } = useAccount({ config });
  const connectors = useConnectors({ config });
  // Use account connector if connected, otherwise find JAW connector from available connectors
  const jawConnector = connectors.find((c) => c.id === 'jaw');
  const activeConnector = parameters.connector ?? connector ?? jawConnector;

  // Use explicit address if provided, otherwise fall back to connected address
  const targetAddress = parameters.address ?? connectedAddress;

  // Enable query if:
  // 1. Connected (existing behavior), OR
  // 2. Connector available (can query capabilities without connection)
  const isConnected = status === 'connected' || (status === 'reconnecting' && activeConnector?.getProvider);
  const canQueryDisconnected = Boolean(activeConnector?.getProvider);

  const enabled = Boolean((isConnected || canQueryDisconnected) && (query.enabled ?? true));

  const queryKey = useMemo(
    () =>
      getCapabilitiesQueryKey({
        address: targetAddress,
        chainId: parameters.chainId ?? chainId,
        connector: activeConnector,
        chainFilter: parameters.chainFilter,
      }),
    [targetAddress, chainId, parameters.chainId, activeConnector, parameters.chainFilter]
  );

  return useQuery({
    ...query,
    enabled,
    gcTime: 0,
    queryFn: activeConnector
      ? async () => {
          // When connected, use the standard flow
          if (isConnected) {
            return getCapabilities(config, {
              ...rest,
              address: targetAddress,
              connector: activeConnector,
            });
          }
          // When disconnected, make direct provider call
          const provider = (await activeConnector.getProvider?.()) as EIP1193Provider | undefined;
          if (!provider) throw new Error('Provider not available');

          return provider.request({
            method: 'wallet_getCapabilities' as never,
            params: [targetAddress, parameters.chainFilter] as never,
          }) as Promise<getCapabilities.ReturnType>;
        }
      : skipToken,
    queryKey,
    staleTime: 60_000, // Cache for 60 seconds since capabilities don't change often
  }) as useCapabilities.ReturnType<selectData>;
}

// ============================================================================
// useSign
// ============================================================================

export namespace useSign {
  export type Parameters<config extends Config = Config, context = unknown> = {
    config?: config;
    mutation?: UseMutationParameters<sign.ReturnType, sign.ErrorType, sign.Parameters<config>, context> | undefined;
  };

  export type ReturnType<config extends Config = Config, context = unknown> = UseMutationResult<
    sign.ReturnType,
    sign.ErrorType,
    sign.Parameters<config>,
    context
  >;
}

/**
 * Hook to sign messages using the unified wallet_sign method (ERC-7871).
 * This combines the functionality of useSignMessage and useSignTypedData.
 *
 * @example
 * ```tsx
 * const { mutate: signMessage, data: signature, isPending } = useSign();
 *
 * // Personal sign (EIP-191)
 * signMessage({
 *   request: {
 *     type: '0x45',
 *     data: { message: 'Hello World' },
 *   },
 * });
 *
 * // Typed data sign (EIP-712)
 * signMessage({
 *   request: {
 *     type: '0x01',
 *     data: {
 *       types: { ... },
 *       primaryType: 'Mail',
 *       domain: { ... },
 *       message: { ... },
 *     },
 *   },
 * });
 *
 * // Sign on a specific chain (useful for smart accounts)
 * signMessage({
 *   chainId: 8453, // Base
 *   request: {
 *     type: '0x45',
 *     data: { message: 'Hello from Base' },
 *   },
 * });
 * ```
 */
export function useSign<config extends Config = ResolvedRegister['config'], context = unknown>(
  parameters: useSign.Parameters<config, context> = {}
): useSign.ReturnType<config, context> {
  const { mutation } = parameters;
  const config = useConfig(parameters as { config?: Config });

  return useMutation({
    ...mutation,
    mutationFn: async (variables) => {
      return sign(config, variables);
    },
    mutationKey: ['sign'],
  }) as useSign.ReturnType<config, context>;
}

// ============================================================================
// useGetCallsHistory
// ============================================================================

export namespace useGetCallsHistory {
  export type Parameters<
    config extends Config = Config,
    selectData = getCallsHistory.ReturnType,
  > = getCallsHistory.Parameters<config> & {
    config?: config;
    query?:
      | Omit<
          UseQueryParameters<
            getCallsHistory.ReturnType,
            getCallsHistory.ErrorType,
            selectData,
            getCallsHistoryQueryKey.Value<config>
          >,
          'gcTime' | 'staleTime'
        >
      | undefined;
  };

  export type ReturnType<selectData = getCallsHistory.ReturnType> = UseQueryReturnType<
    selectData,
    getCallsHistory.ErrorType
  >;
}

/**
 * Hook to get the calls history for an account.
 * Can be called without a connected account if address is provided.
 *
 * @example
 * ```tsx
 * // Get calls history for connected account
 * const { data: history, isLoading } = useGetCallsHistory();
 *
 * // With specific address (works even when not connected)
 * const { data } = useGetCallsHistory({ address: '0x...' });
 *
 * // With pagination
 * const { data } = useGetCallsHistory({
 *   address: '0x...',
 *   limit: 10,
 *   sort: 'desc',
 * });
 * ```
 */
export function useGetCallsHistory<
  config extends Config = ResolvedRegister['config'],
  selectData = getCallsHistory.ReturnType,
>(parameters: useGetCallsHistory.Parameters<config, selectData> = {}): useGetCallsHistory.ReturnType<selectData> {
  const { query = {}, ...rest } = parameters;

  const config = useConfig(rest as { config?: Config });
  const chainId = useChainId({ config });
  const { address: connectedAddress, connector, status } = useAccount({ config });
  const connectors = useConnectors({ config });
  // Use account connector if connected, otherwise find JAW connector from available connectors
  const jawConnector = connectors.find((c) => c.id === 'jaw');
  const activeConnector = parameters.connector ?? connector ?? jawConnector;

  // Use explicit address if provided, otherwise fall back to connected address
  const targetAddress = parameters.address ?? connectedAddress;

  // Enable query if:
  // 1. Connected (existing behavior), OR
  // 2. Explicit address provided AND connector available (disconnected query)
  const isConnected = status === 'connected' || (status === 'reconnecting' && activeConnector?.getProvider);
  const canQueryDisconnected = Boolean(targetAddress && activeConnector?.getProvider);

  const enabled = Boolean((isConnected || canQueryDisconnected) && (query.enabled ?? true));

  const queryKey = useMemo(
    () =>
      getCallsHistoryQueryKey({
        address: targetAddress,
        chainId: parameters.chainId ?? chainId,
        connector: activeConnector,
        index: parameters.index,
        limit: parameters.limit,
        sort: parameters.sort,
      }),
    [targetAddress, chainId, parameters.chainId, activeConnector, parameters.index, parameters.limit, parameters.sort]
  );

  return useQuery({
    ...query,
    enabled,
    gcTime: 0,
    queryFn: activeConnector
      ? async () => {
          // When connected, use the standard flow
          if (isConnected) {
            return getCallsHistory(config, {
              ...rest,
              address: targetAddress,
              connector: activeConnector,
            });
          }
          // When disconnected but have address, make direct provider call
          const provider = (await activeConnector.getProvider?.()) as EIP1193Provider | undefined;
          if (!provider) throw new Error('Provider not available');
          if (!targetAddress) throw new Error('Address is required when not connected');

          return provider.request({
            method: 'wallet_getCallsHistory' as never,
            params: [
              {
                address: targetAddress,
                chainId: parameters.chainId,
                index: parameters.index,
                limit: parameters.limit,
                sort: parameters.sort,
              },
            ] as never,
          }) as Promise<getCallsHistory.ReturnType>;
        }
      : skipToken,
    queryKey,
    staleTime: 30_000, // Cache for 30 seconds
  }) as useGetCallsHistory.ReturnType<selectData>;
}

// ============================================================================
// useAddFunds
// ============================================================================

export namespace useAddFunds {
  export type Parameters<config extends Config = Config, context = unknown> = {
    config?: config;
    mutation?:
      | UseMutationParameters<addFunds.ReturnType, addFunds.ErrorType, addFunds.Parameters<config>, context>
      | undefined;
  };

  export type ReturnType<config extends Config = Config, context = unknown> = UseMutationResult<
    addFunds.ReturnType,
    addFunds.ErrorType,
    addFunds.Parameters<config>,
    context
  >;
}

/**
 * Hook to open the wallet's receive screen.
 *
 * Resolves null when the user closes it. There is no success outcome to branch
 * on: deposits land off-app, so a `mutate` that resolves only means the screen
 * was shown and dismissed.
 *
 * @example
 * ```tsx
 * const { mutate, isPending } = useAddFunds();
 *
 * mutate({});
 * ```
 */
export function useAddFunds<config extends Config = ResolvedRegister['config'], context = unknown>(
  parameters: useAddFunds.Parameters<config, context> = {}
): useAddFunds.ReturnType<config, context> {
  const { mutation } = parameters;
  const config = useConfig(parameters as { config?: Config });

  return useMutation({
    ...mutation,
    mutationFn: async (variables) => {
      return addFunds(config, variables);
    },
    mutationKey: ['addFunds'],
  }) as useAddFunds.ReturnType<config, context>;
}
