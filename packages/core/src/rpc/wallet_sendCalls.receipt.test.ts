// The receipt is reported to the proxy for every caller, keyed or not: a keyless
// dApp is attributed by the forwarded origin. And one waiter per hash, because
// `wallet_getCallsStatus` starts another on every poll while the op is pending.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitForUserOperationReceipt = vi.fn();

vi.mock('../store/chain-clients/utils.js', () => ({
    getBundlerClient: vi.fn(() => ({ waitForUserOperationReceipt })),
}));

vi.mock('../analytics/index.js', () => ({
    notifyReceiptReceived: vi.fn(),
}));

import { notifyReceiptReceived } from '../analytics/index.js';
import { waitForReceiptInBackground } from './wallet_sendCalls.js';

const notifyMock = vi.mocked(notifyReceiptReceived);

const USER_OP_HASH = '0xaaa1'.padEnd(66, '0');
const TX_HASH = '0xbbb2'.padEnd(66, '0');

function succeedingReceipt() {
    return { receipt: { status: '0x1', transactionHash: TX_HASH } };
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

    it('reports a reverted receipt as unsuccessful', async () => {
        waitForUserOperationReceipt.mockResolvedValue({ receipt: { status: '0x0', transactionHash: TX_HASH } });

        await waitForReceiptInBackground(USER_OP_HASH, 1);

        expect(notifyMock.mock.calls[0][0]).toMatchObject({ success: false });
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
