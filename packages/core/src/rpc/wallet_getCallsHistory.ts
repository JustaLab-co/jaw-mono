import { JAW_RPC_URL } from '../constants.js';
import { standardErrors } from '../errors/index.js';
import type { RequestArguments } from '../provider/index.js';
import type { Address } from 'viem';
import { buildHandleJawRpcUrl, fetchRPCRequest } from '../utils/index.js';
import type { CallsHistoryItem } from '../api/routes/index.js';

/**
 * Parameters for wallet_getCallsHistory
 */
export type WalletGetCallsHistoryParams = [
    {
        /** Address to fetch call bundles for (required) */
        address: Address;
        /** Optional chain ID to filter by */
        chainId?: number;
        /** Optional index cursor for pagination */
        index?: number;
        /** Maximum number of bundles to return (default: 20) */
        limit?: number;
        /** Sort direction based on index (default: 'desc' - newest first) */
        sort?: 'asc' | 'desc';
    },
];

/**
 * Response type for wallet_getCallsHistory
 */
export type WalletGetCallsHistoryResponse = CallsHistoryItem[];

/**
 * Handles the wallet_getCallsHistory RPC request.
 * Fetches the call history for a given address from the RPC server.
 *
 * @param request - The RPC request arguments
 * @param apiKey - The API key for authentication, if the caller has one
 * @param connectedAddress - Optional connected account address to inject if no address in params
 * @returns Array of call history items
 */
export async function handleGetCallsHistoryRequest(
    request: RequestArguments,
    apiKey: string | undefined,
    connectedAddress?: Address
): Promise<WalletGetCallsHistoryResponse> {
    const params = request.params as Array<{ address?: Address }> | undefined;

    // Determine which address to use
    let modifiedRequest = request;
    if (!params || params.length === 0 || !params[0]?.address) {
        if (connectedAddress) {
            // Inject the connected account's address
            modifiedRequest = {
                ...request,
                params: [
                    {
                        ...params?.[0],
                        address: connectedAddress,
                    },
                ],
            };
        } else {
            // No address provided and no connected address - throw error
            throw standardErrors.rpc.invalidParams('address is required');
        }
    }

    const rpcUrl = buildHandleJawRpcUrl(JAW_RPC_URL, apiKey);
    const result = await fetchRPCRequest(modifiedRequest, rpcUrl);
    return result as WalletGetCallsHistoryResponse;
}
