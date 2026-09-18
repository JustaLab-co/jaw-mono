import { store } from '../store/index.js';
import { getBundlerClient } from '../store/chain-clients/utils.js';
import type { BundlerClient } from 'viem/account-abstraction';
import { numberToHex } from 'viem';
import { notifyReceiptReceived } from '../analytics/index.js';

/**
 * Receipt in EIP-5792 format
 */
export interface CallReceipt {
    logs: Array<{
        address: `0x${string}`;
        data: `0x${string}`;
        topics: `0x${string}`[];
    }>;
    status: `0x${string}`;
    blockHash: `0x${string}`;
    blockNumber: `0x${string}`;
    gasUsed: `0x${string}`;
    transactionHash: `0x${string}`;
}

/**
 * Call status response in EIP-5792 format
 */
export interface CallStatusResponse {
    /** EIP-5792 version */
    version: string;
    /** The batch ID (userOpHash) */
    id: `0x${string}`;
    /** Chain ID in hex format */
    chainId: `0x${string}`;
    /** Status code: 100=pending, 200=completed, 400=offchain failure, 500=onchain revert */
    status: number;
    /** Whether the operation is atomic (always true for ERC-4337) */
    atomic: boolean;
    /** Transaction receipts (present when completed or reverted) */
    receipts?: CallReceipt[];
}

/**
 * Stores a call status as pending when wallet_sendCalls is called
 * @param userOpHash - The user operation hash returned from sendUserOperation
 * @param chainId - The chain ID where the operation was submitted
 * @param apiKey - Optional API key for notifying the proxy when receipt is received
 */
export function storeCallStatus(userOpHash: string, chainId: number, apiKey?: string): void {
    store.callStatuses.set(userOpHash, {
        status: 'pending',
        chainId,
        apiKey,
    });
}

/**
 * Updates call status to completed when receipt is received
 * @param userOpHash - The user operation hash
 * @param receipts - The receipts from waitForUserOperationReceipt
 */
export function updateCallStatusToCompleted(userOpHash: string, receipts: unknown[]): void {
    store.callStatuses.update(userOpHash, {
        status: 'completed',
        receipts,
    });
}

/**
 * Updates call status to failed when an error occurs
 * @param userOpHash - The user operation hash
 * @param error - The error message or object
 */
export function updateCallStatusToFailed(userOpHash: string, error: string | Error): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    store.callStatuses.update(userOpHash, {
        status: 'failed',
        error: errorMessage,
    });
}

/**
 * Gets the call status for a given batch ID (userOpHash)
 * @param batchId - The batch ID (userOpHash) to get status for
 * @returns The call status or undefined if not found
 */
export function getCallStatus(batchId: string) {
    return store.callStatuses.get(batchId);
}

/**
 * Transforms receipts to EIP-5792 format
 * @param receipts - Raw receipts from storage
 * @returns Transformed receipts in EIP-5792 format
 */
export function transformReceiptsToEIP5792(receipts: unknown[]): CallReceipt[] {
    if (!receipts || receipts.length === 0) {
        return [];
    }

    return receipts.map((receipt: any) => {
        // Handle different receipt formats
        // Format 1: Direct receipt object (from waitForUserOperationReceipt)
        // Format 2: Wrapped receipt with userOpHash, receipt field, etc.
        const actualReceipt = receipt.receipt || receipt;

        // Extract logs - prefer logs from actualReceipt, fallback to top-level logs
        // Logs should only include those relevant to the user operation
        const logs = (actualReceipt.logs || receipt.logs || []).map((log: any) => ({
            address: log.address as `0x${string}`,
            data: log.data || ('0x' as `0x${string}`),
            topics: (log.topics || []) as `0x${string}`[],
        }));

        // Determine status: 0x1 for success, 0x0 for failure
        // Check receipt.status, receipt.success, or actualReceipt.status
        const success =
            actualReceipt.status === '0x1' ||
            actualReceipt.status === 1 ||
            receipt.success === true ||
            actualReceipt.success === true ||
            (actualReceipt.status === undefined && actualReceipt.transactionHash !== undefined);
        const status = success ? ('0x1' as `0x${string}`) : ('0x0' as `0x${string}`);

        // Extract required fields - prefer actualReceipt, fallback to top-level receipt
        const blockHash = (actualReceipt.blockHash || receipt.blockHash) as `0x${string}`;
        const blockNumberRaw = actualReceipt.blockNumber ?? receipt.blockNumber;
        // Ensure blockNumber is always in hex format
        const blockNumber =
            typeof blockNumberRaw === 'string'
                ? blockNumberRaw.startsWith('0x')
                    ? (blockNumberRaw as `0x${string}`)
                    : (numberToHex(BigInt(blockNumberRaw)) as `0x${string}`)
                : (numberToHex(blockNumberRaw) as `0x${string}`);
        const gasUsedRaw = actualReceipt.gasUsed ?? receipt.gasUsed;
        // Ensure gasUsed is always in hex format
        const gasUsed =
            typeof gasUsedRaw === 'string'
                ? gasUsedRaw.startsWith('0x')
                    ? (gasUsedRaw as `0x${string}`)
                    : (numberToHex(BigInt(gasUsedRaw)) as `0x${string}`)
                : (numberToHex(gasUsedRaw) as `0x${string}`);
        const transactionHash = (actualReceipt.transactionHash || receipt.transactionHash) as `0x${string}`;

        return {
            logs,
            status,
            blockHash,
            blockNumber,
            gasUsed,
            transactionHash,
        };
    });
}

/**
 * Gets the call status in EIP-5792 format
 * @param batchId - The batch ID (userOpHash) to get status for
 * @returns EIP-5792 formatted response or undefined if not found
 */
export function getCallStatusEIP5792(batchId: string): CallStatusResponse | undefined {
    const callStatus = getCallStatus(batchId);

    if (!callStatus) {
        return undefined;
    }

    // Return status in expected format
    // EIP-5792 Status codes:
    // 100 = pending (not completed onchain)
    // 200 = completed (included onchain without reverts)
    // 400 = offchain failure (not included onchain, wallet won't retry)
    // 500 = complete revert (reverted completely, has receipt with status 0x0)
    // 600 = partial revert (not applicable for ERC-4337 atomic operations)
    let statusCode = 100; // pending
    if (callStatus.status === 'completed') {
        statusCode = 200; // Completed successfully
    } else if (callStatus.status === 'failed') {
        // Distinguish between offchain failure (400) and onchain revert (500)
        if (callStatus.receipts && callStatus.receipts.length > 0) {
            // Has receipts but failed → onchain revert (status 500)
            statusCode = 500;
        } else {
            // No receipts → offchain failure (status 400)
            statusCode = 400;
        }
    }

    // Transform receipts to EIP-5792 format
    const transformedReceipts = callStatus.receipts ? transformReceiptsToEIP5792(callStatus.receipts) : undefined;

    // Format chainId as hex string
    const chainId = callStatus.chainId ?? 1;
    const chainIdHex = numberToHex(chainId) as `0x${string}`;

    // Return in EIP-5792 format
    return {
        version: '2.0.0',
        id: batchId as `0x${string}`,
        chainId: chainIdHex,
        status: statusCode,
        atomic: true, // ERC-4337 user operations are atomic
        receipts: transformedReceipts,
    };
}

/** The waiters running right now, by userOpHash. */
const receiptWaiters = new Map<string, Promise<void>>();

/**
 * Starts a background task to wait for user operation receipt
 * This function does NOT await - it runs in the background
 *
 * One waiter per hash: `wallet_getCallsStatus` re-triggers this on every poll
 * while the status is pending, so a dApp polling a twelve-second transaction
 * once a second would otherwise run a dozen waiters that each report the same
 * receipt. A waiter that times out leaves the map, so the next poll retries.
 *
 * @param userOpHash - The user operation hash to wait for
 * @param chainId - The chain ID where the operation was submitted
 * @param apiKey - Optional API key for notifying the proxy when receipt is received
 */
export function waitForReceiptInBackground(userOpHash: string, chainId: number, apiKey?: string): Promise<void> {
    const running = receiptWaiters.get(userOpHash);
    if (running) return running;

    const waiter = pollForReceipt(userOpHash, chainId, apiKey).finally(() => {
        receiptWaiters.delete(userOpHash);
    });
    receiptWaiters.set(userOpHash, waiter);
    return waiter;
}

async function pollForReceipt(userOpHash: string, chainId: number, apiKey?: string): Promise<void> {
    try {
        // Get bundler client for the chain
        const bundlerClient = getBundlerClient(chainId);
        if (!bundlerClient) {
            const error = new Error(`No bundler client found for chain ${chainId}`);
            updateCallStatusToFailed(userOpHash, error);
            return;
        }
        // Status remains 'pending' while waiting
        const receipt = await (bundlerClient as BundlerClient).waitForUserOperationReceipt({
            hash: userOpHash as `0x${string}`,
        });

        // Check receipt status to determine if transaction succeeded or failed
        // The receipt from waitForUserOperationReceipt has a receipt field with status
        const actualReceipt = (receipt as any).receipt || receipt;
        const receiptStatus = actualReceipt.status;

        // Determine if transaction succeeded:
        // - status === '0x1' or 1 means success
        // - status === '0x0' or 0 means failure (reverted)
        // - If status is undefined but receipt exists, assume success (included on-chain)
        const isSuccess =
            receiptStatus === '0x1' ||
            receiptStatus === 1 ||
            (receiptStatus === undefined && actualReceipt.transactionHash !== undefined);

        // Fire-and-forget notification to proxy. A keyless caller is attributed by
        // the forwarded origin, so the receipt is reported either way.
        notifyReceiptReceived({
            userOpHash: userOpHash as `0x${string}`,
            transactionHash: actualReceipt.transactionHash,
            success: isSuccess,
            apiKey,
        });

        if (isSuccess) {
            // Transaction succeeded - mark as completed
            updateCallStatusToCompleted(userOpHash, [receipt]);
        } else {
            // Transaction failed/reverted - mark as failed but still store receipt
            // This allows wallet_getCallsStatus to return the receipt with status 0x0
            updateCallStatusToFailed(userOpHash, new Error('Transaction reverted'));
            // Still store the receipt so it can be returned in EIP-5792 format
            // This will result in status code 500 (onchain revert) instead of 400 (offchain failure)
            store.callStatuses.update(userOpHash, {
                receipts: [receipt],
            });
        }
    } catch (error) {
        // Check if this is a timeout error
        const isTimeoutError = error instanceof Error && error.name === 'WaitForUserOperationReceiptTimeoutError';

        if (isTimeoutError) {
            // Timeout doesn't mean failure - operation may still be pending on-chain
            // Keep status as 'pending' so user can check again later via wallet_getCallsStatus
            console.warn(`Receipt polling timed out for ${userOpHash}, keeping status as pending`);
        } else {
            // For other errors, mark as failed
            console.error(`Error waiting for receipt for ${userOpHash}:`, error);
            updateCallStatusToFailed(userOpHash, error as Error);
        }
    }
}
