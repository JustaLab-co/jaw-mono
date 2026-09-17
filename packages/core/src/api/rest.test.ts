import { afterEach, describe, expect, it, vi } from 'vitest';

import { restCall } from './rest.js';
import { notifyReceiptReceived } from '../analytics/receiptNotification.js';
import { setDappOrigin } from '../dappOrigin.js';
import { JAW_BASE_URL, JAW_PROXY_URL } from '../constants.js';

const request = vi.fn();

vi.mock('./axiosController.js', async () => {
    const actual = await vi.importActual<typeof import('./axiosController.js')>('./axiosController.js');
    return {
        ...actual,
        backendInstance: () => ({ request }),
    };
});

// The relay calls are made from the keys origin too, since grantPermissions writes
// through here. Without the header a keyless dApp's permission is refused on the
// relay write, after the transaction has already been signed and sent.
describe('restCall and the calling dApp', () => {
    afterEach(() => {
        setDappOrigin(undefined);
        request.mockReset();
    });

    function headersSent() {
        return request.mock.calls[0][0].headers as Record<string, string>;
    }

    async function callThrough(headers?: Record<string, string>) {
        request.mockResolvedValue({ data: { result: { data: {} } } });
        await restCall('GET_PERMISSION', 'GET', {}, headers, { hash: '0xabc' }, undefined, JAW_PROXY_URL);
    }

    it('names the dApp alongside the key it was given', async () => {
        setDappOrigin('https://dapp.example');

        await callThrough({ 'x-api-key': 'k1' });

        expect(headersSent()).toEqual({ 'x-api-key': 'k1', 'x-dapp-origin': 'https://dapp.example' });
    });

    it('names the dApp when there is no key at all', async () => {
        setDappOrigin('https://dapp.example');

        await callThrough();

        expect(headersSent()).toEqual({ 'x-dapp-origin': 'https://dapp.example' });
    });

    it('sends no dApp header from a dApp page, where the browser sets the Origin', async () => {
        await callThrough({ 'x-api-key': 'k1' });

        expect(headersSent()).toEqual({ 'x-api-key': 'k1' });
    });

    // Analytics is the wallet API, not the proxy, and a keyless caller has no key
    // for it to bill the signature to. Its service lists `x-dapp-origin` in
    // Access-Control-Allow-Headers, so the preflight passes.
    it('names the dApp on the wallet API too', async () => {
        setDappOrigin('https://dapp.example');
        request.mockResolvedValue({ data: { result: { data: {} } } });

        await restCall('LOG_SIGNATURE', 'POST', { address: '0xabc' });

        expect(headersSent()).toEqual({ 'x-dapp-origin': 'https://dapp.example' });
    });

    // The patch that reports a landed transaction is the one call a keyless dApp
    // cannot be identified on any other way: it leaves after the popup is gone.
    describe('the receipt patch', () => {
        const receipt = {
            userOpHash: `0xaaa1${'0'.repeat(60)}` as `0x${string}`,
            transactionHash: `0xbbb2${'0'.repeat(60)}` as `0x${string}`,
            success: true,
        };

        function paramsSent() {
            return request.mock.calls[0][0].params;
        }

        it('names the dApp and sends no empty key', () => {
            setDappOrigin('https://dapp.example');
            request.mockResolvedValue({ data: { result: { data: {} } } });

            notifyReceiptReceived(receipt);

            expect(headersSent()).toEqual({ 'x-dapp-origin': 'https://dapp.example' });
            expect(paramsSent()).toBeUndefined();
        });

        it('sends the key as a query param when the caller has one', () => {
            setDappOrigin('https://dapp.example');
            request.mockResolvedValue({ data: { result: { data: {} } } });

            notifyReceiptReceived({ ...receipt, apiKey: 'k1' });

            expect(paramsSent()).toEqual({ 'api-key': 'k1' });
        });
    });

    // A server the dApp runs itself, which app-specific mode allows. Which dApp the
    // user is on is ours to know and not theirs to be told.
    it('sends no dApp header to a server the dApp pointed us at', async () => {
        setDappOrigin('https://dapp.example');
        request.mockResolvedValue({ data: { result: { data: {} } } });

        await restCall(
            'LOOKUP_PASSKEYS',
            'GET',
            { credentialIds: ['abc'] },
            undefined,
            undefined,
            undefined,
            'https://passkeys.dapp.example'
        );

        expect(headersSent()).toEqual({});
    });

    // `https://api.justaname.id.evil.com` starts with our base url and is a host of
    // theirs, so the match is on the origin.
    it('sends no dApp header to a host that only looks like ours', async () => {
        setDappOrigin('https://dapp.example');
        request.mockResolvedValue({ data: { result: { data: {} } } });

        await restCall(
            'LOOKUP_PASSKEYS',
            'GET',
            { credentialIds: ['abc'] },
            undefined,
            undefined,
            undefined,
            `${JAW_BASE_URL}.evil.com/wallet/v2/passkeys`
        );

        expect(headersSent()).toEqual({});
    });
});
