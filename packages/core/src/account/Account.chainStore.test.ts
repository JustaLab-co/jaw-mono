import { describe, it, expect, beforeEach } from 'vitest';
import { sepolia } from 'viem/chains';

import { Account } from './Account.js';
import { store, ChainClients, getClient, type Chain } from '../store/index.js';
import { JAW_RPC_URL } from '../constants.js';

// `buildChainConfig` is private and writes the shared chain store as a side effect,
// which is the behaviour under test here.
const buildChainConfig = (
    chainId: number,
    apiKey?: string,
    paymasterUrl?: string,
    paymasterContext?: Record<string, unknown>
): Chain =>
    (
        Account as unknown as {
            buildChainConfig: (
                chainId: number,
                apiKey?: string,
                paymasterUrl?: string,
                paymasterContext?: Record<string, unknown>
            ) => Chain;
        }
    ).buildChainConfig(chainId, apiKey, paymasterUrl, paymasterContext);

const keyless = `${JAW_RPC_URL}?chainId=${sepolia.id}`;
const keyed = `${keyless}&api-key=k1`;

describe('buildChainConfig and the stored chain entry', () => {
    beforeEach(() => {
        store.chains.set([]);
        ChainClients.setState({}, true);
    });

    it('adds a chain that is not stored yet', () => {
        buildChainConfig(sepolia.id, 'k1');

        expect(store.chains.get()).toEqual([{ id: sepolia.id, rpcUrl: keyed }]);
    });

    // `chains` is persisted, and on the keys origin that store is shared by every dApp
    // the user opens. First-write-wins let a keyless entry outlive its session and serve
    // the next keyed one, which reaches the proxy with no key and is refused.
    it('lets a keyed session replace the entry a keyless one left behind', () => {
        buildChainConfig(sepolia.id);
        expect(store.chains.get()?.[0].rpcUrl).toBe(keyless);

        buildChainConfig(sepolia.id, 'k1');

        expect(store.chains.get()).toEqual([{ id: sepolia.id, rpcUrl: keyed }]);
    });

    it('replaces in place, so the order of the list is kept', () => {
        store.chains.set([
            { id: 1, rpcUrl: `${JAW_RPC_URL}?chainId=1` },
            { id: sepolia.id, rpcUrl: keyless },
            { id: 8453, rpcUrl: `${JAW_RPC_URL}?chainId=8453` },
        ]);

        buildChainConfig(sepolia.id, 'k1');

        expect(store.chains.get()?.map((c) => c.id)).toEqual([1, sepolia.id, 8453]);
        expect(store.chains.get()?.[1].rpcUrl).toBe(keyed);
    });

    it('drops the cached clients so the next read uses the new url', () => {
        buildChainConfig(sepolia.id);
        expect(getClient(sepolia.id)?.transport.url).toBe(keyless);

        buildChainConfig(sepolia.id, 'k1');

        expect(getClient(sepolia.id)?.transport.url).toBe(keyed);
    });

    // Rebuilding on every call would cost the multicall batching, which only folds calls
    // issued on the same client instance.
    it('keeps the cached clients when the entry is unchanged', () => {
        buildChainConfig(sepolia.id, 'k1');
        const client = getClient(sepolia.id);

        buildChainConfig(sepolia.id, 'k1');

        expect(getClient(sepolia.id)).toBe(client);
    });

    it('replaces when only the paymaster changed', () => {
        buildChainConfig(sepolia.id, 'k1', 'https://paymaster.test/a');
        const client = getClient(sepolia.id);

        buildChainConfig(sepolia.id, 'k1', 'https://paymaster.test/b');

        expect(store.chains.get()?.[0].paymaster?.url).toBe('https://paymaster.test/b');
        expect(getClient(sepolia.id)).not.toBe(client);
    });
});
