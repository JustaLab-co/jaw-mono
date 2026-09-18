import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBundlerClient } from './smartAccount.js';
import { setDappOrigin } from '../dappOrigin.js';
import type { Chain } from '../store/index.js';

// The send path used to build its clients on a raw `http()`, so a keyless dApp
// reached the proxy from the keys origin with nothing identifying it: the
// capabilities read on the way in succeeded and the userOp on Confirm was refused.
describe('naming the calling dApp on the userOp path', () => {
    afterEach(() => {
        setDappOrigin(undefined);
        vi.unstubAllGlobals();
    });

    const CHAIN = { id: 1, rpcUrl: 'https://rpc.example' } as Chain;

    function stubFetch() {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );
        vi.stubGlobal('fetch', fetchMock);
        return () => new Headers(fetchMock.mock.calls[0][1].headers);
    }

    it('names the dApp on the bundler transport', async () => {
        const headers = stubFetch();
        setDappOrigin('https://dapp.example');

        await getBundlerClient(CHAIN).request({ method: 'eth_chainId' } as never);

        expect(headers().get('x-dapp-origin')).toBe('https://dapp.example');
    });

    it('sends no dApp header when this instance was told nothing', async () => {
        const headers = stubFetch();

        await getBundlerClient(CHAIN).request({ method: 'eth_chainId' } as never);

        expect(headers().has('x-dapp-origin')).toBe(false);
    });
});
