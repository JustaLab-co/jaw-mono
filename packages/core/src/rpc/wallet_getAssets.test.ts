import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetAssetsRequest, type WalletGetAssetsParams } from './wallet_getAssets.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';

describe('handleGetAssetsRequest', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: {} }), { status: 200 })
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const sentParams = () => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        return JSON.parse(init.body as string).params[0];
    };

    it('keeps includeDefiTokens when it fills in the default chainFilter', async () => {
        await handleGetAssetsRequest(
            { method: 'wallet_getAssets', params: [{ account: ACCOUNT, includeDefiTokens: false }] },
            undefined
        );

        const params = sentParams();
        expect(params.includeDefiTokens).toBe(false);
        expect(params.account).toBe(ACCOUNT);
        expect(params.chainFilter).toEqual(expect.arrayContaining(['0x1']));
    });

    it('sends the caller chainFilter and includeDefiTokens unchanged', async () => {
        const params: WalletGetAssetsParams = {
            account: ACCOUNT,
            chainFilter: ['0x2105'],
            assetTypeFilter: ['native', 'erc20'],
            includeDefiTokens: false,
        };

        await handleGetAssetsRequest({ method: 'wallet_getAssets', params: [params] }, undefined);

        expect(sentParams()).toEqual(params);
    });

    it('adds no includeDefiTokens when the caller leaves it out', async () => {
        await handleGetAssetsRequest({ method: 'wallet_getAssets', params: [{ account: ACCOUNT }] }, undefined);

        expect(sentParams()).not.toHaveProperty('includeDefiTokens');
    });
});
