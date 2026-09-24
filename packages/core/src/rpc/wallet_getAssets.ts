import { RequestArguments } from '../provider/index.js';
import { JAW_RPC_URL } from '../constants.js';
import { buildHandleJawRpcUrl, fetchRPCRequest, hexStringFromNumber } from '../utils/index.js';
import { getSupportedChains } from '../account/smartAccount.js';

// ============================================================================
// EIP-7811 Types
// ============================================================================

/**
 * Asset type identifier
 */
export type AssetType = 'native' | 'erc20';

/**
 * Asset metadata
 */
export type AssetMetadata = {
    decimals: number;
    name: string;
    symbol: string;
} | null;

/**
 * Individual asset in the wallet_getAssets response
 */
export type Asset = {
    /** Token contract address, null for native tokens */
    address: string | null;
    /** Balance in hex format */
    balance: string;
    /** Asset metadata */
    metadata: AssetMetadata;
    /** Asset type */
    type: AssetType;
};

/**
 * Asset filter entry for a specific asset
 */
export type AssetFilterEntry = {
    /** Token contract address */
    address: `0x${string}`;
    /** Asset type */
    type: AssetType;
};

/**
 * Asset filter - maps chain ID (hex) to array of assets to filter by
 */
export type AssetFilter = Record<`0x${string}`, AssetFilterEntry[]>;

/**
 * Request parameters for wallet_getAssets
 */
export type WalletGetAssetsParams = {
    /** Address of the account to get assets for (required) */
    account: string;
    /** Narrows results to specified chains (optional, hex format like "0x1") */
    chainFilter?: string[];
    /** Restricts results by asset category (optional) */
    assetTypeFilter?: AssetType[];
    /** Filters by specific assets per chain (optional) */
    assetFilter?: AssetFilter;
};

/**
 * Response type for wallet_getAssets
 * Maps chain ID (hex) to array of assets
 */
export type WalletGetAssetsResponse = {
    [chainId: string]: Asset[];
};

// ============================================================================
// Handler
// ============================================================================

/**
 * Handles wallet_getAssets (EIP-7811) requests.
 * Automatically injects chainFilter based on showTestnets preference if not provided.
 *
 * @param request - The request arguments containing params
 * @param apiKey - API key for authentication, if the caller has one
 * @param showTestnets - Whether to include testnet chains (default: false)
 * @returns The assets response from the RPC server
 */
export async function handleGetAssetsRequest(
    request: RequestArguments,
    apiKey: string | undefined,
    showTestnets = false
): Promise<unknown> {
    const rpcUrl = buildHandleJawRpcUrl(JAW_RPC_URL, apiKey);

    // If chainFilter is not provided in params, inject default chains based on showTestnets preference
    let requestArgs = request;

    // Extract the params object (first element in the array)
    const paramsObj =
        Array.isArray(request.params) && request.params[0] ? (request.params[0] as Record<string, unknown>) : undefined;

    // If chainFilter is not provided, inject it based on showTestnets preference
    if (paramsObj && !('chainFilter' in paramsObj)) {
        const supportedChains = getSupportedChains(showTestnets);
        // Convert chain IDs to hex format as required by EIP-7811
        const chainFilter = supportedChains.map((chain) => hexStringFromNumber(chain.id));

        requestArgs = {
            ...request,
            params: [
                {
                    ...paramsObj,
                    chainFilter,
                },
            ],
        };
    }

    const result = await fetchRPCRequest(requestArgs, rpcUrl);
    return result;
}
