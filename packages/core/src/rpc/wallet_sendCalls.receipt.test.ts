// The receipt is reported to the proxy for every caller, keyed or not: a keyless
// dApp is attributed by the forwarded origin. And one waiter per hash, because
// `wallet_getCallsStatus` starts another on every poll while the op is pending.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const waitForUserOperationReceipt = vi.fn();
const chain = {
    getBlockNumber: vi.fn(),
    getLogs: vi.fn(),
    getTransactionReceipt: vi.fn(),
};

vi.mock('../store/chain-clients/utils.js', () => ({
    getBundlerClient: vi.fn(() => ({ waitForUserOperationReceipt, client: {} })),
}));

vi.mock('viem/actions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('viem/actions')>()),
    getBlockNumber: () => chain.getBlockNumber(),
    getLogs: (_client: unknown, args: unknown) => chain.getLogs(args),
    getTransactionReceipt: (_client: unknown, args: unknown) => chain.getTransactionReceipt(args),
}));

vi.mock('../analytics/index.js', () => ({
    notifyReceiptReceived: vi.fn(),
}));

import { notifyReceiptReceived } from '../analytics/index.js';
import { getCallStatus, storeCallStatus, waitForReceiptInBackground } from './wallet_sendCalls.js';

const notifyMock = vi.mocked(notifyReceiptReceived);

const USER_OP_HASH = '0xaaa1'.padEnd(66, '0');
const TX_HASH = '0xbbb2'.padEnd(66, '0');

// The shape viem's waitForUserOperationReceipt resolves to: the transaction
// status is already formatted, and `success` is the user operation's own result.
function succeedingReceipt() {
    return { success: true, receipt: { status: 'success', transactionHash: TX_HASH } };
}

describe('waitForReceiptInBackground', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        waitForUserOperationReceipt.mockResolvedValue(succeedingReceipt());
    });

    // Keys builds the account with `preference?.apiKey || ''`, so a keyless dApp
    // arrives as the empty string rather than as undefined.
    it.each(['real-key', undefined, ''])('reports the receipt with apiKey %o', async (apiKey) => {
        await waitForReceiptInBackground(USER_OP_HASH, 1, apiKey);

        expect(notifyMock).toHaveBeenCalledTimes(1);
        expect(notifyMock.mock.calls[0][0]).toMatchObject({
            userOpHash: USER_OP_HASH,
            transactionHash: TX_HASH,
            success: true,
            apiKey,
        });
    });

    it('reports a reverted user operation as unsuccessful, though its bundle was mined', async () => {
        waitForUserOperationReceipt.mockResolvedValue({
            success: false,
            receipt: { status: 'success', transactionHash: TX_HASH },
        });

        await waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(notifyMock.mock.calls[0][0]).toMatchObject({ success: false });
    });

    it('marks a successful user operation as completed', async () => {
        storeCallStatus(USER_OP_HASH, 1);

        await waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(getCallStatus(USER_OP_HASH)?.status).toBe('completed');
    });

    it('runs one waiter per hash while the first is still polling', async () => {
        let settle: (receipt: unknown) => void = () => undefined;
        waitForUserOperationReceipt.mockReturnValue(
            new Promise((resolve) => {
                settle = resolve;
            })
        );

        const first = waitForReceiptInBackground(USER_OP_HASH, 1);
        const second = waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(waitForUserOperationReceipt).toHaveBeenCalledTimes(1);

        settle(succeedingReceipt());
        await Promise.all([first, second]);

        expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it('polls again once the previous waiter is done', async () => {
        await waitForReceiptInBackground(USER_OP_HASH, 1);
        await waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(waitForUserOperationReceipt).toHaveBeenCalledTimes(2);
    });

    it('keeps waiters for different hashes apart', async () => {
        const other = '0xccc3'.padEnd(66, '0');

        await Promise.all([waitForReceiptInBackground(USER_OP_HASH, 1), waitForReceiptInBackground(other, 1)]);

        expect(waitForUserOperationReceipt).toHaveBeenCalledTimes(2);
        expect(notifyMock).toHaveBeenCalledTimes(2);
    });
});

// Etherspot answers "Missing/invalid userOpHash" for EntryPoint v0.8 operations it
// has already bundled. That used to mark a successful operation as failed.
describe('waitForReceiptInBackground when the bundler returns no receipt', () => {
    const MINED = { status: 'success', transactionHash: TX_HASH };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        waitForUserOperationReceipt.mockRejectedValue(new Error('Missing/invalid userOpHash'));
        chain.getBlockNumber.mockResolvedValue(5_000n);
        chain.getTransactionReceipt.mockResolvedValue(MINED);
        storeCallStatus(USER_OP_HASH, 1);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('completes the operation from the EntryPoint event', async () => {
        chain.getLogs.mockResolvedValue([{ transactionHash: TX_HASH, args: { success: true } }]);

        await waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(chain.getLogs).toHaveBeenCalledWith(
            expect.objectContaining({ args: { userOpHash: USER_OP_HASH }, fromBlock: 4_900n })
        );
        expect(getCallStatus(USER_OP_HASH)).toMatchObject({ status: 'completed' });
        expect(notifyMock.mock.calls[0][0]).toMatchObject({ transactionHash: TX_HASH, success: true });
    });

    it('searches from genesis on a chain younger than the lookup window', async () => {
        chain.getBlockNumber.mockResolvedValue(50n);
        chain.getLogs.mockResolvedValue([{ transactionHash: TX_HASH, args: { success: true } }]);

        await waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(chain.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 0n }));
        expect(getCallStatus(USER_OP_HASH)).toMatchObject({ status: 'completed' });
    });

    it('fails an operation the EntryPoint reports as reverted', async () => {
        chain.getLogs.mockResolvedValue([{ transactionHash: TX_HASH, args: { success: false } }]);

        await waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(getCallStatus(USER_OP_HASH)).toMatchObject({ status: 'failed', receipts: [{ receipt: MINED }] });
    });

    it('keeps an operation not yet on chain pending, instead of failing it', async () => {
        vi.useFakeTimers();
        chain.getLogs.mockResolvedValue([]);

        const waiting = waitForReceiptInBackground(USER_OP_HASH, 1);
        await vi.runAllTimersAsync();
        await waiting;

        expect(chain.getLogs).toHaveBeenCalledTimes(20);
        expect(getCallStatus(USER_OP_HASH)).toMatchObject({ status: 'pending' });
        expect(notifyMock).not.toHaveBeenCalled();
    });
});
