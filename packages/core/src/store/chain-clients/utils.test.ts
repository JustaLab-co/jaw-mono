import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { sepolia, optimismSepolia, arbitrumSepolia } from 'viem/chains';

import { ChainClients } from './store.js';
import { createClients, createInitialChains, getClient, getBundlerClient } from './utils.js';
import { JAW_RPC_URL } from '../../constants.js';
import { setDappOrigin } from '../../dappOrigin.js';

describe('chain-clients/utils', () => {
    beforeEach(() => {
        // Reset store state before each test - use replace to fully reset
        ChainClients.setState({}, true);
    });

    it('should create clients for a single chain', () => {
        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
                nativeCurrency: {
                    name: sepolia.nativeCurrency.name,
                    symbol: sepolia.nativeCurrency.symbol,
                    decimal: sepolia.nativeCurrency.decimals,
                },
            },
        ]);

        const state = ChainClients.getState();
        expect(Object.keys(state).length).toBe(1);
        expect(state[sepolia.id]).toBeDefined();
        expect(state[sepolia.id].client).toBeDefined();
        expect(state[sepolia.id].bundlerClient).toBeDefined();
    });

    it('should create clients for multiple chains', () => {
        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
                nativeCurrency: {
                    name: sepolia.nativeCurrency.name,
                    symbol: sepolia.nativeCurrency.symbol,
                    decimal: sepolia.nativeCurrency.decimals,
                },
            },
            {
                id: optimismSepolia.id,
                rpcUrl: optimismSepolia.rpcUrls.default.http[0],
                nativeCurrency: {
                    name: optimismSepolia.nativeCurrency.name,
                    symbol: optimismSepolia.nativeCurrency.symbol,
                    decimal: optimismSepolia.nativeCurrency.decimals,
                },
            },
        ]);

        const state = ChainClients.getState();
        expect(Object.keys(state).length).toBe(2);

        expect(state[sepolia.id].client).toBeDefined();
        expect(state[optimismSepolia.id].client).toBeDefined();

        expect(state[sepolia.id].bundlerClient).toBeDefined();
        expect(state[optimismSepolia.id].bundlerClient).toBeDefined();
    });

    it('should skip chains without rpcUrl', () => {
        createClients([
            {
                id: 1,
                // No rpcUrl
            },
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
            },
        ]);

        const state = ChainClients.getState();
        expect(Object.keys(state).length).toBe(1);
        expect(state[1]).toBeUndefined();
        expect(state[sepolia.id]).toBeDefined();
    });

    it('should get public client by chain id', () => {
        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
            },
        ]);

        const client = getClient(sepolia.id);
        expect(client).toBeDefined();
        expect(client?.chain?.id).toBe(sepolia.id);
    });

    it('should return undefined for non-existent chain', () => {
        const client = getClient(999);
        expect(client).toBeUndefined();
    });

    it('should get bundler client by chain id', () => {
        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
            },
        ]);

        const bundlerClient = getBundlerClient(sepolia.id);
        expect(bundlerClient).toBeDefined();
    });

    it('should handle native currency with default decimals', () => {
        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
                nativeCurrency: {
                    name: 'Test Token',
                    symbol: 'TEST',
                    // No decimal specified, should default to 18
                },
            },
        ]);

        const client = getClient(sepolia.id);
        expect(client).toBeDefined();
        expect(client?.chain?.nativeCurrency.decimals).toBe(18);
    });

    it('should return undefined for missing clients', () => {
        const client = getClient(999);
        const bundlerClient = getBundlerClient(999);

        expect(client).toBeUndefined();
        expect(bundlerClient).toBeUndefined();
    });

    it('should properly configure client with chain details', () => {
        const testChain = {
            id: sepolia.id,
            rpcUrl: sepolia.rpcUrls.default.http[0],
            nativeCurrency: {
                name: 'Sepolia Ether',
                symbol: 'ETH',
                decimal: 18,
            },
        };

        createClients([testChain]);

        const client = getClient(sepolia.id);
        expect(client?.chain).toBeDefined();
        expect(client?.chain?.id).toBe(testChain.id);
        expect(client?.chain?.name).toBe(testChain.nativeCurrency.name);
        expect(client?.chain?.nativeCurrency.symbol).toBe(testChain.nativeCurrency.symbol);
        expect(client?.chain?.nativeCurrency.decimals).toBe(testChain.nativeCurrency.decimal);
    });

    // The receipt wait in waitForReceiptInBackground polls at the bundler client's
    // pollingInterval, which viem derives from chain.blockTime. Without blockTime it
    // assumes a 12s L1 and clamps to 4s — up to 4s of dead time after inclusion on a
    // 250ms-block chain. Both the public and bundler client must pick it up.
    it('should derive a sub-second polling interval for fast chains', () => {
        createClients([
            {
                id: arbitrumSepolia.id,
                rpcUrl: arbitrumSepolia.rpcUrls.default.http[0],
                nativeCurrency: {
                    name: arbitrumSepolia.nativeCurrency.name,
                    symbol: arbitrumSepolia.nativeCurrency.symbol,
                    decimal: arbitrumSepolia.nativeCurrency.decimals,
                },
            },
        ]);

        // viem: min(max(floor(blockTime / 2), 500), 4000) — 250ms blocks -> 500ms
        expect(arbitrumSepolia.blockTime).toBe(250);
        expect(getClient(arbitrumSepolia.id)?.pollingInterval).toBe(500);
        expect(getBundlerClient(arbitrumSepolia.id)?.pollingInterval).toBe(500);
    });

    // The synthesized chain must carry viem's `contracts` through, or the client's
    // `batch.multicall` has no Multicall3 address to aggregate through and silently
    // degrades to one request per eth_call.
    it('should carry the Multicall3 address through to the public client', () => {
        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
                nativeCurrency: {
                    name: sepolia.nativeCurrency.name,
                    symbol: sepolia.nativeCurrency.symbol,
                    decimal: sepolia.nativeCurrency.decimals,
                },
            },
        ]);

        const client = getClient(sepolia.id);
        expect(client?.chain?.contracts?.multicall3?.address).toBe(sepolia.contracts.multicall3.address);
        expect(client?.batch?.multicall).toBe(true);
    });

    it('should leave a chain viem does not know without multicall config', () => {
        const unknownChainId = 999_999;

        createClients([
            {
                id: unknownChainId,
                rpcUrl: 'https://rpc.example/unknown',
                nativeCurrency: { name: 'Unknown', symbol: 'UNK', decimal: 18 },
            },
        ]);

        // No contracts to carry over; viem swallows the missing-address lookup and
        // issues plain eth_calls, so enabling the batch option stays safe.
        expect(getClient(unknownChainId)?.chain?.contracts).toBeUndefined();
    });

    it('should leave the polling interval at viem default for chains with no known blockTime', () => {
        // sepolia carries no blockTime in viem, so behaviour is unchanged there.
        expect(sepolia.blockTime).toBeUndefined();

        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
                nativeCurrency: {
                    name: sepolia.nativeCurrency.name,
                    symbol: sepolia.nativeCurrency.symbol,
                    decimal: sepolia.nativeCurrency.decimals,
                },
            },
        ]);

        expect(getClient(sepolia.id)?.pollingInterval).toBe(4000);
        expect(getBundlerClient(sepolia.id)?.pollingInterval).toBe(4000);
    });

    it('should accumulate clients when called multiple times with different chains', () => {
        // First call with sepolia
        createClients([
            {
                id: sepolia.id,
                rpcUrl: sepolia.rpcUrls.default.http[0],
            },
        ]);

        let state = ChainClients.getState();
        expect(Object.keys(state).length).toBe(1);
        expect(state[sepolia.id]).toBeDefined();

        // Second call with optimismSepolia - should ADD to existing state
        createClients([
            {
                id: optimismSepolia.id,
                rpcUrl: optimismSepolia.rpcUrls.default.http[0],
            },
        ]);

        state = ChainClients.getState();
        expect(Object.keys(state).length).toBe(2);
        expect(state[sepolia.id]).toBeDefined();
        expect(state[optimismSepolia.id]).toBeDefined();
    });

    it('should replace client when called multiple times with same chain', () => {
        const firstRpcUrl = sepolia.rpcUrls.default.http[0];
        const secondRpcUrl = 'https://different-rpc-url.com';

        // First call
        createClients([
            {
                id: sepolia.id,
                rpcUrl: firstRpcUrl,
            },
        ]);

        const firstClient = getClient(sepolia.id);
        expect(firstClient).toBeDefined();

        // Second call with same chain but different RPC URL
        createClients([
            {
                id: sepolia.id,
                rpcUrl: secondRpcUrl,
            },
        ]);

        const secondClient = getClient(sepolia.id);
        expect(secondClient).toBeDefined();
        // Client should be replaced (different instance)
        expect(secondClient).not.toBe(firstClient);

        // Should still only have one chain in state
        const state = ChainClients.getState();
        expect(Object.keys(state).length).toBe(1);
    });
});

describe('createInitialChains api-key in the rpc url', () => {
    it('appends the api-key when the caller has one', () => {
        const chains = createInitialChains('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6');

        expect(chains.length).toBeGreaterThan(0);
        for (const chain of chains) {
            expect(chain.rpcUrl).toBe(`${JAW_RPC_URL}?chainId=${chain.id}&api-key=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`);
        }
    });

    // Dropped rather than sent empty, which would read as a malformed key
    // instead of as no key at all.
    it('omits the parameter entirely when there is no key', () => {
        const chains = createInitialChains();

        expect(chains.length).toBeGreaterThan(0);
        for (const chain of chains) {
            expect(chain.rpcUrl).toBe(`${JAW_RPC_URL}?chainId=${chain.id}`);
            expect(chain.rpcUrl).not.toContain('api-key');
        }
    });
});

describe('naming the calling dApp on the wire', () => {
    afterEach(() => {
        setDappOrigin(undefined);
        vi.unstubAllGlobals();
        ChainClients.setState({}, true);
    });

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

    async function callThrough(rpcUrl: string) {
        ChainClients.setState({}, true);
        createClients([{ id: 1, rpcUrl }]);
        await getClient(1)?.getChainId();
    }

    // A dApp's own page never names one, and the browser is already putting the
    // right Origin on the request.
    it('sends no dApp header when this instance was told nothing', async () => {
        const headers = stubFetch();

        await callThrough(`${JAW_RPC_URL}?chainId=1`);

        expect(headers().has('x-dapp-origin')).toBe(false);
    });

    it('names the dApp on our own proxy', async () => {
        const headers = stubFetch();
        setDappOrigin('https://dapp.example');

        await callThrough(`${JAW_RPC_URL}?chainId=1`);

        expect(headers().get('x-dapp-origin')).toBe('https://dapp.example');
    });

    // The rpc url is ours whatever host it points at, so the header cannot hang off
    // matching the production one: a staging or local backend would silently stop
    // being told which dApp is calling. The one url that may belong to somebody
    // else is the paymaster's, and that is where the check lives.
    it('names the dApp on a backend that is not the production one', async () => {
        const headers = stubFetch();
        setDappOrigin('https://dapp.example');

        await callThrough('http://localhost:3013/proxy/v1/rpc?chainId=1');

        expect(headers().get('x-dapp-origin')).toBe('https://dapp.example');
    });
});
