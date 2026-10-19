import type { Config, Connector } from '@wagmi/core';
import type { Address, Hex } from 'viem';
import type { AssetType, AssetFilter } from '@jaw.id/core';

// ============================================================================
// getCapabilitiesQueryKey
// ============================================================================

export namespace getCapabilitiesQueryKey {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
    chainFilter?: Hex[];
  };

  export type Value<config extends Config = Config> = readonly [
    'capabilities',
    {
      address: Address | undefined;
      chainId: number | undefined;
      connectorUid: string | undefined;
      chainFilter: Hex[] | undefined;
    },
  ];
}

/**
 * Creates a query key for getCapabilities.
 * Used by useCapabilities hook and for cache invalidation.
 */
export function getCapabilitiesQueryKey<config extends Config>(
  parameters: getCapabilitiesQueryKey.Parameters<config>
): getCapabilitiesQueryKey.Value<config> {
  const { address, chainId, connector, chainFilter } = parameters;
  return [
    'capabilities',
    {
      address,
      chainId,
      connectorUid: connector?.uid,
      chainFilter,
    },
  ] as const;
}

// ============================================================================
// getPermissionsQueryKey
// ============================================================================

export namespace getPermissionsQueryKey {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
  };

  export type Value<config extends Config = Config> = readonly [
    'permissions',
    {
      address: Address | undefined;
      chainId: number | undefined;
      connectorUid: string | undefined;
    },
  ];
}

/**
 * Creates a query key for getPermissions.
 * Used by usePermissions hook and for cache invalidation.
 */
export function getPermissionsQueryKey<config extends Config>(
  parameters: getPermissionsQueryKey.Parameters<config>
): getPermissionsQueryKey.Value<config> {
  const { address, chainId, connector } = parameters;
  return [
    'permissions',
    {
      address,
      chainId,
      connectorUid: connector?.uid,
    },
  ] as const;
}

// ============================================================================
// getRecoveryQueryKey
// ============================================================================

export namespace getRecoveryQueryKey {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    connector?: Connector;
  };

  export type Value<config extends Config = Config> = readonly [
    'recovery',
    {
      address: Address | undefined;
      connectorUid: string | undefined;
    },
  ];
}

/**
 * Creates a query key for getRecovery.
 * Used by useRecovery hook and for cache invalidation. Carries no chainId:
 * recovery is account-level, so switching chains does not refetch.
 */
export function getRecoveryQueryKey<config extends Config>(
  parameters: getRecoveryQueryKey.Parameters<config>
): getRecoveryQueryKey.Value<config> {
  const { address, connector } = parameters;
  return [
    'recovery',
    {
      address,
      connectorUid: connector?.uid,
    },
  ] as const;
}

// ============================================================================
// getAssetsQueryKey
// ============================================================================

export namespace getAssetsQueryKey {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
    chainFilter?: string[];
    assetTypeFilter?: AssetType[];
    assetFilter?: AssetFilter;
  };

  export type Value<config extends Config = Config> = readonly [
    'assets',
    {
      address: Address | undefined;
      chainId: number | undefined;
      connectorUid: string | undefined;
      chainFilter: string[] | undefined;
      assetTypeFilter: AssetType[] | undefined;
      assetFilter: AssetFilter | undefined;
    },
  ];
}

/**
 * Creates a query key for getAssets.
 * Used by useGetAssets hook and for cache invalidation.
 */
export function getAssetsQueryKey<config extends Config>(
  parameters: getAssetsQueryKey.Parameters<config>
): getAssetsQueryKey.Value<config> {
  const { address, chainId, connector, chainFilter, assetTypeFilter, assetFilter } = parameters;
  return [
    'assets',
    {
      address,
      chainId,
      connectorUid: connector?.uid,
      chainFilter,
      assetTypeFilter,
      assetFilter,
    },
  ] as const;
}

// ============================================================================
// getCallsHistoryQueryKey
// ============================================================================

export namespace getCallsHistoryQueryKey {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
    index?: number;
    limit?: number;
    sort?: 'asc' | 'desc';
  };

  export type Value<config extends Config = Config> = readonly [
    'callsHistory',
    {
      address: Address | undefined;
      chainId: number | undefined;
      connectorUid: string | undefined;
      index: number | undefined;
      limit: number | undefined;
      sort: 'asc' | 'desc' | undefined;
    },
  ];
}

/**
 * Creates a query key for getCallsHistory.
 * Used by useCallsHistory hook and for cache invalidation.
 */
export function getCallsHistoryQueryKey<config extends Config>(
  parameters: getCallsHistoryQueryKey.Parameters<config>
): getCallsHistoryQueryKey.Value<config> {
  const { address, chainId, connector, index, limit, sort } = parameters;
  return [
    'callsHistory',
    {
      address,
      chainId,
      connectorUid: connector?.uid,
      index,
      limit,
      sort,
    },
  ] as const;
}
