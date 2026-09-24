import { describe, it, expect, beforeEach } from 'vitest';

import { create } from './createJAWSDK.js';
import { Mode } from '../provider/interface.js';
import { sdkstore, store } from '../store/index.js';
import { SDK_VERSION } from '../sdk-info.js';
import { JAW_RPC_URL } from '../constants.js';

describe('create() chain registration', () => {
    // create() writes into a module-level singleton, so without this the
    // account chain a later test asserts on could have been set by an earlier one.
    beforeEach(() => {
        sdkstore.setState(
            { chains: [], keys: {}, account: {}, config: { version: SDK_VERSION }, callStatuses: {} },
            true
        );
    });

    it('registers chains when an api-key is given', () => {
        create({ apiKey: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', appName: 'Test' });

        const chains = store.chains.get();
        expect(chains.length).toBeGreaterThan(0);
        expect(chains[0].rpcUrl).toContain('api-key=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6');
    });

    // The chain list used to be built only when a key was present, so a config
    // without one produced an SDK with no chains and no error saying why. The
    // backend decides whether a request is served; the SDK does not get to decide
    // it by leaving the store empty.
    it('registers the same chains when there is no api-key', () => {
        create({ appName: 'Test' });

        const chains = store.chains.get();
        expect(chains.length).toBeGreaterThan(0);
        for (const chain of chains) {
            expect(chain.rpcUrl).toBe(`${JAW_RPC_URL}?chainId=${chain.id}`);
        }
    });

    // App-specific mode hands the key to the dApp's own UIHandler, which has nowhere
    // to get one. It used to be caught in createSigner, so a misconfigured app got
    // an SDK that built fine and failed on its first request instead.
    it('refuses app-specific mode with no api-key, at config time', () => {
        expect(() => create({ appName: 'Test', preference: { mode: Mode.AppSpecific } })).toThrow(/API key/i);
    });

    it('honours defaultChainId without an api-key', () => {
        create({ appName: 'Test', defaultChainId: 8453 });

        expect(store.chains.get().some((c) => c.id === 8453)).toBe(true);
        expect(store.account.get().chain?.id).toBe(8453);
    });
});
