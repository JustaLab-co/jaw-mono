import type { Address } from 'viem';
import { restCall } from '../api/index.js';
// By path: `paramUtils` is not part of the package's public surface.
import { isHexAddress } from '../rpc/paramUtils.js';
import type { IssuanceType } from '../api/routes/index.js';

export type { IssuanceType } from '../api/routes/index.js';
export { notifyReceiptReceived, type NotifyReceiptParams } from './receiptNotification.js';

/**
 * Parameters for logging account issuance
 */
export interface LogAccountIssuanceParams {
    /** The smart account address */
    address: Address;
    /** The type of account creation */
    type: IssuanceType;
    /** API key for authentication, if the caller has one */
    apiKey?: string;
}

/**
 * Log an account issuance for analytics and billing purposes.
 *
 * This function is fire-and-forget - it does not block and silently
 * swallows any errors to ensure it never affects the main flow.
 *
 * @param params - The issuance parameters
 */
export function logAccountIssuance(params: LogAccountIssuanceParams): void {
    try {
        const { address, type, apiKey } = params;
        // Both calls here are fire and forget, so nothing downstream ever rejects
        // what they send and a value that is not an address lands in the table as
        // a row nothing can join. Shape, not checksum: a lowercase one is an address.
        if (!isHexAddress(address)) return;

        restCall(
            'LOG_ACCOUNT_ISSUANCE',
            'POST',
            {
                address,
                type,
                timestamp: Date.now(),
            },
            apiKey ? { 'x-api-key': apiKey } : {}
        ).catch(() => {
            // Silently swallow async errors
        });
    } catch {
        // Silently swallow any synchronous errors
    }
}

/**
 * Parameters for logging a wallet signature
 */
export interface LogSignatureParams {
    /** The address that produced the signature */
    address: Address;
    /** API key for authentication, if the caller has one */
    apiKey?: string;
}

/**
 * Log a wallet signature for analytics purposes (per-workspace volume metric).
 *
 * This function is fire-and-forget - it does not block and silently
 * swallows any errors to ensure it never affects the signing flow.
 *
 * @param params - The signature parameters
 */
export function logSignature(params: LogSignatureParams): void {
    try {
        const { address, apiKey } = params;
        if (!isHexAddress(address)) return;

        restCall('LOG_SIGNATURE', 'POST', { address }, apiKey ? { 'x-api-key': apiKey } : {}).catch(() => {
            // Silently swallow async errors
        });
    } catch {
        // Silently swallow any synchronous errors
    }
}
