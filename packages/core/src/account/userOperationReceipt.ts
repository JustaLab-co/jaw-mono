import { getAbiItem, type Hex } from 'viem';
import { getBlockNumber, getLogs, getTransactionReceipt } from 'viem/actions';
import {
    entryPoint08Abi,
    entryPoint08Address,
    type BundlerClient,
    type UserOperationReceipt,
} from 'viem/account-abstraction';

export type OperationReceipt = Pick<UserOperationReceipt, 'success' | 'receipt'>;

// How long the chain is read once the bundler has failed to answer: 20 reads,
// 3 seconds apart.
const CHAIN_LOOKUP_ATTEMPTS = 20;
const CHAIN_LOOKUP_INTERVAL_MS = 3_000;
// Covers the time between sending and the bundler's refusal. RPC providers cap
// the eth_getLogs range, some at 500 blocks, and the range grows while polling.
const CHAIN_LOOKUP_BLOCKS = 100n;

const userOperationEvent = getAbiItem({ abi: entryPoint08Abi, name: 'UserOperationEvent' });

/**
 * Waits for a user operation's receipt, reading the chain when the bundler fails
 * to return it. Some bundlers fail the lookup for an operation they did bundle:
 * Etherspot answers "Missing/invalid userOpHash" for EntryPoint v0.8, whose own
 * event carries the same result.
 *
 * Resolves undefined when the operation is not on chain yet. A bundler timeout is
 * rethrown, since it already means "not yet".
 */
export async function waitForOperationReceipt(
    bundlerClient: BundlerClient,
    hash: Hex
): Promise<OperationReceipt | undefined> {
    try {
        return await bundlerClient.waitForUserOperationReceipt({ hash });
    } catch (error) {
        if (error instanceof Error && error.name === 'WaitForUserOperationReceiptTimeoutError') throw error;
        console.warn(`The bundler returned no receipt for ${hash}, reading it from the chain:`, error);
    }

    const client = bundlerClient.client;
    if (!client) return undefined;

    try {
        const fromBlock = (await getBlockNumber(client)) - CHAIN_LOOKUP_BLOCKS;
        for (let attempt = 1; attempt <= CHAIN_LOOKUP_ATTEMPTS; attempt++) {
            const [event] = await getLogs(client, {
                address: entryPoint08Address,
                event: userOperationEvent,
                args: { userOpHash: hash },
                fromBlock,
                strict: true,
            });
            if (event) {
                const receipt = await getTransactionReceipt(client, { hash: event.transactionHash });
                return { success: event.args.success, receipt };
            }
            if (attempt < CHAIN_LOOKUP_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, CHAIN_LOOKUP_INTERVAL_MS));
            }
        }
    } catch (error) {
        console.warn(`Reading the receipt for ${hash} from the chain failed:`, error);
    }
    return undefined;
}
