import type { Hash, Address } from 'viem';

/**
 * Calls history API route
 */
export const CALLS_HISTORY_ROUTE = '/rpc/calls-history';

/**
 * Request payload for updating call status
 */
export interface UpdateCallStatusRequest {
    /** Status code: 200 for success, 500 for reverted */
    status: number;
    /** The transaction hash from the receipt */
    transactionHash: Hash;
}

/**
 * Request payload for getting calls history
 */
export interface GetCallsHistoryRequest {
    /** Address to fetch call bundles for */
    address: Address;
    /** Optional chain ID to filter by */
    chainId?: number;
    /** Optional index cursor for pagination */
    index?: number;
    /** Maximum number of bundles to return (default: 20) */
    limit?: number;
    /** Sort direction based on index (default: 'desc' - newest first) */
    sort?: 'asc' | 'desc';
}

/**
 * Response item for calls history
 */
export interface CallsHistoryItem {
    /** userOpHash */
    id: Hash;
    /** Auto-incrementing index per address (for cursor pagination) */
    index: number;
    /** Wallet address */
    address: Address;
    /** 100=Pending, 200=Completed, 500=Onchain Revert */
    status: number;
    /** Unix timestamp in seconds */
    timestamp: number;
    /** Chain ID */
    chainId: number;
    /** Transaction hash (null when pending) */
    transactionHash: Hash | null;
}

/**
 * Route definitions for calls history operations
 */
export interface CallsHistoryRoutes {
    UPDATE_CALL_STATUS: {
        request: UpdateCallStatusRequest;
        response: void;
        headers?: Record<string, string>;
        pathParams: { id: string };
        queryParams: { 'api-key'?: string };
    };
    GET_CALLS_HISTORY: {
        request: GetCallsHistoryRequest;
        response: CallsHistoryItem[];
        headers?: Record<string, string>;
        pathParams?: never;
        queryParams: { 'api-key': string };
    };
}
