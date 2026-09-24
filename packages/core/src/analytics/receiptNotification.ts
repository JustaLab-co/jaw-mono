import type { Hash } from 'viem';
import { restCall } from '../api/index.js';
import { JAW_PROXY_URL } from '../constants.js';

/**
 * Parameters for notifying receipt received
 */
export interface NotifyReceiptParams {
    /** The user operation hash */
    userOpHash: Hash;
    /** The transaction hash from the receipt */
    transactionHash: Hash;
    /** Whether the transaction was successful (true) or reverted (false) */
    success: boolean;
    /** API key for authentication, if the caller has one */
    apiKey?: string;
}

/**
 * Notify the proxy that a transaction receipt has been received.
 *
 * This function is fire-and-forget - it does not block and silently
 * swallows any errors to ensure it never affects the main flow.
 *
 * @param params - The notification parameters
 */
export function notifyReceiptReceived(params: NotifyReceiptParams): void {
    try {
        const { userOpHash, transactionHash, success, apiKey } = params;

        // Status: 200 for success, 500 for reverted
        const status = success ? 200 : 500;

        restCall(
            'UPDATE_CALL_STATUS',
            'PATCH',
            {
                status,
                transactionHash,
            },
            undefined,
            { id: userOpHash },
            undefined,
            JAW_PROXY_URL,
            apiKey ? { 'api-key': apiKey } : undefined
        ).catch(() => {
            // Silently swallow async errors
        });
    } catch {
        // Silently swallow any synchronous errors
    }
}
