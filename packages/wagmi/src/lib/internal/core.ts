import { type Config, type Connector, getConnectorClient, disconnect as wagmiDisconnect } from '@wagmi/core';
import type { Address, Hex } from 'viem';
import { numberToHex } from 'viem';
import {
  type PermissionsDetail,
  type WalletGrantPermissionsResponse,
  type WalletGetPermissionsResponse,
  type RevokePermissionApiResponse,
  type WalletConnectCapabilities,
  type WalletGetAssetsResponse,
  type AssetType,
  type AssetFilter,
  type PersonalSignRequestData,
  type TypedDataRequestData,
  type WalletGetCallsHistoryResponse,
} from '@jaw.id/core';
import type { AccountWithCapabilities } from '../Connector.js';

// ===========================================================================
// connect
// ===========================================================================

export namespace connect {
  export type Parameters = {
    /** The connector to use for connection */
    connector: Connector;
    /** Optional chain ID to connect to */
    chainId?: number;
    /**
     * Capabilities to request during connection.
     * When provided, uses wallet_connect instead of eth_requestAccounts.
     */
    capabilities?: WalletConnectCapabilities;
    /** Force reconnection even if already connected */
    force?: boolean;
  };

  export type ReturnType = {
    /** Connected accounts (with capabilities if requested) */
    accounts: readonly Address[] | readonly AccountWithCapabilities[];
    /** Connected chain ID */
    chainId: number;
  };

  export type ErrorType = Error;
}

/**
 * Connects to the wallet using the specified connector.
 *
 * @example
 * ```ts
 * // Basic connect
 * const result = await Actions.connect(config, {
 *   connector: jawWallet({ apiKey: 'xxx' }),
 * });
 *
 * // Connect with capabilities (subname issuance)
 * const result = await Actions.connect(config, {
 *   connector: jawWallet({ apiKey: 'xxx' }),
 *   capabilities: {
 *     subnameTextRecords: [
 *       { key: 'avatar', value: 'https://example.com/avatar.png' },
 *     ],
 *   },
 * });
 * ```
 */
export async function connect<config extends Config>(
  config: config,
  parameters: connect.Parameters
): Promise<connect.ReturnType> {
  const { connector, chainId, capabilities } = parameters;

  // This action reimplements @wagmi/core's connect to forward JAW's
  // `capabilities` to the connector, but previously skipped the part that
  // records the connection in wagmi's store — so useAccount()/isConnected
  // stayed false even though the provider had connected. The block below
  // mirrors @wagmi/core's connect: flip to 'connecting', wire the change/
  // disconnect emitter listeners, persist the recent connector, then register
  // the connection (connections + current + status 'connected') via setState.
  try {
    config.setState((x) => ({ ...x, status: 'connecting' }));
    connector.emitter.emit('message', { type: 'connecting' });

    // `withCapabilities` is wagmi's flag for the result shape; ask for the
    // richer one whenever we requested wallet capabilities, so the caller still
    // gets each account's capabilities (a SIWE signature, for instance) back.
    const wantsCapabilities = Boolean(capabilities && Object.keys(capabilities).length > 0);
    const result = await connector.connect({
      chainId,
      capabilities,
      withCapabilities: wantsCapabilities,
    } as never);

    connector.emitter.off('connect', config._internal.events.connect);
    connector.emitter.on('change', config._internal.events.change);
    connector.emitter.on('disconnect', config._internal.events.disconnect);
    await config.storage?.setItem('recentConnectorId', connector.id);

    const accounts = (result.accounts as ReadonlyArray<Address | AccountWithCapabilities>).map((account) =>
      typeof account === 'string' ? account : account.address
    ) as unknown as readonly [Address, ...Address[]];

    config.setState((x) => ({
      ...x,
      connections: new Map(x.connections).set(connector.uid, {
        accounts,
        chainId: result.chainId,
        connector,
      }),
      current: connector.uid,
      status: 'connected',
    }));

    return {
      accounts: result.accounts as connect.ReturnType['accounts'],
      chainId: result.chainId,
    };
  } catch (error) {
    config.setState((x) => ({
      ...x,
      // Keep an existing connection intact if this one failed.
      status: x.current ? 'connected' : 'disconnected',
    }));
    throw error;
  }
}

// ============================================================================
// grantPermissions
// ============================================================================

export namespace grantPermissions {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
    /** Timestamp this permission is valid until (exclusive, unix seconds) */
    expiry: number;
    /** Spender address */
    spender: Address;
    /** Permissions details */
    permissions: PermissionsDetail;
  };

  export type ReturnType = WalletGrantPermissionsResponse;
  export type ErrorType = Error;
}

/**
 * Grants permissions to a spender address.
 * This calls wallet_grantPermissions on the connected wallet.
 */
export async function grantPermissions<config extends Config>(
  config: config,
  parameters: grantPermissions.Parameters<config>
): Promise<grantPermissions.ReturnType> {
  const { address, chainId, connector, expiry, spender, permissions } = parameters;

  // The wallet resolves the target chain from the hex chainId in params —
  // the connector does not need to be switched to that chain.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  const result = await client.request({
    method: 'wallet_grantPermissions' as never,
    params: [
      {
        expiry,
        spender,
        permissions,
        chainId: chainId ? `0x${chainId.toString(16)}` : undefined,
      },
    ] as never,
  });

  return result as grantPermissions.ReturnType;
}

// ============================================================================
// getPermissions
// ============================================================================

export namespace getPermissions {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
  };

  export type ReturnType = WalletGetPermissionsResponse;
  export type ErrorType = Error;
}

/**
 * Gets the current permissions for an address.
 * This calls wallet_getPermissions on the connected wallet.
 */
export async function getPermissions<config extends Config>(
  config: config,
  parameters: getPermissions.Parameters<config> = {}
): Promise<getPermissions.ReturnType> {
  const { address, chainId, connector } = parameters;

  // Chain-agnostic relay read — no need for the connector to be on chainId.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  const result = await client.request({
    method: 'wallet_getPermissions' as never,
    // The relay filters by chain when chainId travels in the params; without
    // it the response spans every chain.
    params: [{ address, ...(chainId !== undefined ? { chainId: numberToHex(chainId) } : {}) }] as never,
  });

  return result as getPermissions.ReturnType;
}

// ============================================================================
// revokePermissions
// ============================================================================

export namespace revokePermissions {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
    /** ID of the permission to revoke (permission hash from contract) */
    id: `0x${string}`;
  };

  export type ReturnType = RevokePermissionApiResponse;
  export type ErrorType = Error;
}

/**
 * Revokes a permission by its ID.
 * This calls wallet_revokePermissions on the connected wallet.
 */
export async function revokePermissions<config extends Config>(
  config: config,
  parameters: revokePermissions.Parameters<config>
): Promise<revokePermissions.ReturnType> {
  const { address, chainId, connector, id } = parameters;

  // The wallet derives the chain from the permission record itself (fetched
  // from the relay by id), so the connector's current chain is irrelevant.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  const result = await client.request({
    method: 'wallet_revokePermissions' as never,
    params: [{ address, id }] as never,
  });

  return result as revokePermissions.ReturnType;
}

// ============================================================================
// disconnect
// ============================================================================

export namespace disconnect {
  export type Parameters = {
    /** Specific connector to disconnect from. If omitted, disconnects active connector. */
    connector?: Connector;
  };

  export type ReturnType = void;
  export type ErrorType = Error;
}

/**
 * Disconnects from the wallet.
 *
 * @example
 * ```ts
 * // Disconnect active connector
 * await Actions.disconnect(config);
 *
 * // Disconnect specific connector
 * await Actions.disconnect(config, { connector: jawWallet({ apiKey: 'xxx' }) });
 * ```
 */
export async function disconnect<config extends Config>(
  config: config,
  parameters: disconnect.Parameters = {}
): Promise<disconnect.ReturnType> {
  const { connector } = parameters;
  await wagmiDisconnect(config, { connector });
}

// ============================================================================
// getAssets
// ============================================================================

export namespace getAssets {
  export type Parameters<config extends Config = Config> = {
    /** Address of the account to get assets for */
    address?: Address;
    chainId?: number;
    connector?: Connector;
    /** Narrows results to specified chain IDs (hex format like "0x1") */
    chainFilter?: string[];
    /** Restricts results by asset category */
    assetTypeFilter?: AssetType[];
    /** Filters by specific assets per chain */
    assetFilter?: AssetFilter;
  };

  export type ReturnType = WalletGetAssetsResponse;
  export type ErrorType = Error;
}

/**
 * Gets the assets for an address.
 * This calls wallet_getAssets on the connected wallet.
 *
 * @example
 * ```ts
 * const assets = await Actions.getAssets(config, {
 *   chainFilter: ['0x1', '0xa'], // Mainnet and Optimism
 * });
 * ```
 */
export async function getAssets<config extends Config>(
  config: config,
  parameters: getAssets.Parameters<config> = {}
): Promise<getAssets.ReturnType> {
  const { address, chainId, connector, chainFilter, assetTypeFilter, assetFilter } = parameters;

  // Multi-chain read scoped by chainFilter — no need for the connector to be
  // on chainId.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  const result = await client.request({
    method: 'wallet_getAssets' as never,
    params: [
      {
        account: address,
        chainFilter,
        assetTypeFilter,
        assetFilter,
      },
    ] as never,
  });

  return result as getAssets.ReturnType;
}

// ============================================================================
// getCapabilities
// ============================================================================

/** Response type for wallet_getCapabilities (EIP-5792) */
export type WalletGetCapabilitiesResponse = Record<Hex, Record<string, unknown>>;

export namespace getCapabilities {
  export type Parameters<config extends Config = Config> = {
    /** Address of the account to get capabilities for (optional) */
    address?: Address;
    chainId?: number;
    connector?: Connector;
    /** Filter by specific chain IDs (hex format like "0x1") */
    chainFilter?: Hex[];
  };

  export type ReturnType = WalletGetCapabilitiesResponse;
  export type ErrorType = Error;
}

/**
 * Gets the wallet capabilities for an address.
 * This calls wallet_getCapabilities on the wallet (EIP-5792).
 * Can be called without a connected account.
 *
 * @example
 * ```ts
 * // Get capabilities for all chains
 * const capabilities = await Actions.getCapabilities(config, {});
 *
 * // Get capabilities for specific address
 * const capabilities = await Actions.getCapabilities(config, {
 *   address: '0x...',
 * });
 *
 * // Get capabilities filtered by chains
 * const capabilities = await Actions.getCapabilities(config, {
 *   chainFilter: ['0x1', '0xa'], // Mainnet and Optimism
 * });
 * ```
 */
export async function getCapabilities<config extends Config>(
  config: config,
  parameters: getCapabilities.Parameters<config> = {}
): Promise<getCapabilities.ReturnType> {
  const { address, chainId, connector, chainFilter } = parameters;

  // Multi-chain read scoped by chainFilter — no need for the connector to be
  // on chainId.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  const result = await client.request({
    method: 'wallet_getCapabilities' as never,
    params: [address, chainFilter] as never,
  });

  return result as getCapabilities.ReturnType;
}

// ============================================================================
// sign
// ============================================================================

export namespace sign {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    chainId?: number;
    connector?: Connector;
    /** The signing request - supports personal sign (0x45) and typed data (0x01) */
    request: PersonalSignRequestData | TypedDataRequestData;
  };

  export type ReturnType = Hex;
  export type ErrorType = Error;
}

/**
 * Signs a message using the wallet_sign method (ERC-7871).
 * This is a unified signing method that combines personal_sign and eth_signTypedData_v4.
 *
 * @example
 * ```ts
 * // Personal sign (EIP-191)
 * const signature = await Actions.sign(config, {
 *   request: {
 *     type: '0x45',
 *     data: { message: 'Hello World' },
 *   },
 * });
 *
 * // Typed data sign (EIP-712)
 * const signature = await Actions.sign(config, {
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
 * ```
 */
export async function sign<config extends Config>(
  config: config,
  parameters: sign.Parameters<config>
): Promise<sign.ReturnType> {
  const { address, chainId, connector, request } = parameters;

  // The wallet resolves the target chain from the hex chainId in params
  // (ERC-7871) — the connector does not need to be switched to that chain.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  const result = await client.request({
    method: 'wallet_sign' as never,
    params: [
      {
        request,
        address,
        chainId: chainId ? `0x${chainId.toString(16)}` : undefined,
      },
    ] as never,
  });

  return result as sign.ReturnType;
}

// ============================================================================
// getCallsHistory
// ============================================================================

export namespace getCallsHistory {
  export type Parameters<config extends Config = Config> = {
    /** Address of the account to get calls history for (required when not connected) */
    address?: Address;
    chainId?: number;
    connector?: Connector;
    /** Optional index cursor for pagination */
    index?: number;
    /** Maximum number of bundles to return (default: 20) */
    limit?: number;
    /** Sort direction based on index (default: 'desc' - newest first) */
    sort?: 'asc' | 'desc';
  };

  export type ReturnType = WalletGetCallsHistoryResponse;
  export type ErrorType = Error;
}

/**
 * Gets the calls history for an address.
 * This calls wallet_getCallsHistory on the wallet.
 * Can be called without a connected account if address is provided.
 *
 * @example
 * ```ts
 * // Get calls history for connected account
 * const history = await Actions.getCallsHistory(config, {});
 *
 * // Get calls history for specific address (works without connection)
 * const history = await Actions.getCallsHistory(config, {
 *   address: '0x...',
 * });
 *
 * // With pagination
 * const history = await Actions.getCallsHistory(config, {
 *   address: '0x...',
 *   limit: 10,
 *   sort: 'desc',
 * });
 * ```
 */
export async function getCallsHistory<config extends Config>(
  config: config,
  parameters: getCallsHistory.Parameters<config> = {}
): Promise<getCallsHistory.ReturnType> {
  const { address, chainId, connector, index, limit, sort } = parameters;

  // chainId here is a history filter, not a routing target — no need for the
  // connector to be on that chain.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  const result = await client.request({
    method: 'wallet_getCallsHistory' as never,
    params: [
      {
        address,
        chainId,
        index,
        limit,
        sort,
      },
    ] as never,
  });

  return result as getCallsHistory.ReturnType;
}

// ============================================================================
// addFunds
// ============================================================================

export namespace addFunds {
  export type Parameters<config extends Config = Config> = {
    address?: Address;
    connector?: Connector;
    /**
     * Chain the receive QR pins via EIP-681. Defaults to the connected chain.
     * Not a routing target: nothing is sent, so the connector does not have to
     * be on it.
     */
    chainId?: number;
  };

  /**
   * Always null. Deposits land off-app, so the wallet has no outcome to report
   * and the user closing the screen is the normal finish.
   */
  export type ReturnType = null;
  export type ErrorType = Error;
}

/**
 * Opens the wallet's receive screen: the chains the account's address works on,
 * an EIP-681 QR, and the address itself.
 *
 * The destination is always the connected account, resolved by the wallet. It
 * cannot be passed in — `address` here selects which connected account to act
 * as, exactly as in the other actions.
 *
 * @example
 * ```ts
 * await Actions.addFunds(config);
 * ```
 */
export async function addFunds<config extends Config>(
  config: config,
  parameters: addFunds.Parameters<config> = {}
): Promise<addFunds.ReturnType> {
  const { address, chainId, connector } = parameters;

  // chainId picks which chain the QR names, so the connector does not need to
  // be on it — the address is the same on every chain either way.
  const client = await getConnectorClient(config, {
    account: address,
    chainId,
    connector,
    assertChainId: false,
  });

  await client.request({
    method: 'wallet_addFunds' as never,
    params: [{ chainId }] as never,
  });

  return null;
}
