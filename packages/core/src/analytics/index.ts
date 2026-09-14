import type { Address } from 'viem';
import { restCall } from '../api/index.js';
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
    /** API key for authentication. Absent means there is nobody to attribute to. */
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
        // The endpoint authenticates on this header and the record is for
        // billing, so an issuance with no key has nothing to attribute it to.
        if (!apiKey) return;

        restCall(
            'LOG_ACCOUNT_ISSUANCE',
            'POST',
            {
                address,
                type,
                timestamp: Date.now(),
            },
            { 'x-api-key': apiKey }
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
    /** API key for authentication */
    apiKey: string;
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

        restCall('LOG_SIGNATURE', 'POST', { address }, { 'x-api-key': apiKey }).catch(() => {
            // Silently swallow async errors
        });
    } catch {
        // Silently swallow any synchronous errors
    }
}
