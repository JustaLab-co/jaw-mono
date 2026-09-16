// A receipt is reported to the proxy whether or not the caller has a key: a keyless
// dApp is attributed by the forwarded origin, so gating the call on the key would
// leave its transactions unrecorded.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
    restCall: vi.fn().mockResolvedValue(undefined),
}));

import { restCall } from '../api/index.js';
import { notifyReceiptReceived } from './receiptNotification.js';

const restCallMock = vi.mocked(restCall);

const receipt = {
    userOpHash: '0xaaa1'.padEnd(66, '0') as `0x${string}`,
    transactionHash: '0xbbb2'.padEnd(66, '0') as `0x${string}`,
    success: true,
};

function queryParamsOfLastCall() {
    return restCallMock.mock.calls.at(-1)?.[7];
}

describe('notifyReceiptReceived', () => {
    beforeEach(() => {
        restCallMock.mockClear();
    });

    it('sends the api-key as a query param when the caller has one', () => {
        notifyReceiptReceived({ ...receipt, apiKey: 'real-key' });

        expect(restCallMock).toHaveBeenCalledTimes(1);
        expect(queryParamsOfLastCall()).toEqual({ 'api-key': 'real-key' });
    });

    // Keys builds the account with `preference?.apiKey || ''`, so a keyless dApp
    // arrives here as the empty string rather than as undefined.
    it.each([undefined, ''])('still notifies with no key (%o), and omits the param', (apiKey) => {
        notifyReceiptReceived({ ...receipt, apiKey });

        expect(restCallMock).toHaveBeenCalledTimes(1);
        expect(queryParamsOfLastCall()).toBeUndefined();
    });

    it('reports a revert as status 500', () => {
        notifyReceiptReceived({ ...receipt, success: false });

        expect(restCallMock.mock.calls[0][2]).toMatchObject({ status: 500 });
    });
});
