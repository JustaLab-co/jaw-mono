import { describe, it, expect, beforeEach } from 'vitest';

import { sdkstore, account, chains, keys, config, callStatuses, store } from './store.js';
import { SDK_VERSION } from '../sdk-info.js';
import type { SignInWithEthereumCapabilityResponse } from '../rpc/index.js';

describe('store', () => {
    beforeEach(() => {
        // Reset store state before each test - use replace to fully reset
        sdkstore.setState(
            {
                chains: [],
                keys: {},
                account: {},
                config: { version: SDK_VERSION },
                callStatuses: {},
            },
            true
        );
    });

    describe('account actions', () => {
        it('should initialize with empty account', () => {
            const state = account.get();
            expect(state).toEqual({});
        });

        it('should set account data', () => {
            account.set({
                accounts: ['0x1234567890123456789012345678901234567890'],
            });

            const state = account.get();
            expect(state.accounts).toBeDefined();
            expect(state.accounts?.length).toBe(1);
            expect(state.accounts?.[0]).toBe('0x1234567890123456789012345678901234567890');
        });

        it('should merge account data on set', () => {
            account.set({
                accounts: ['0x1234567890123456789012345678901234567890'],
            });

            const siweCapability: SignInWithEthereumCapabilityResponse = {
                message: 'test message',
                signature: '0x123',
            };
            account.set({
                capabilities: { signInWithEthereum: siweCapability },
            });

            const state = account.get();
            expect(state.accounts?.length).toBe(1);
            expect(state.capabilities).toEqual({ signInWithEthereum: siweCapability });
        });

        it('should set chain data in account', () => {
            account.set({
                chain: {
                    id: 1,
                    rpcUrl: 'https://eth.example.com',
                },
            });

            const state = account.get();
            expect(state.chain).toBeDefined();
            expect(state.chain?.id).toBe(1);
        });

        it('should clear account data', () => {
            account.set({
                accounts: ['0x1234567890123456789012345678901234567890'],
                capabilities: {
                    signInWithEthereum: { message: 'test', signature: '0x123' } as SignInWithEthereumCapabilityResponse,
                },
            });

            account.clear();

            const state = account.get();
            expect(state).toEqual({});
        });

        it('should preserve lastAccount across clear (disconnect / session expiry)', () => {
            // clear() runs on disconnect and on session-TTL expiry — exactly the
            // moments after which the next connect should still show "Continue
            // as". The hint must outlive the connection state.
            const lastAccount = { credentialId: 'A1b2-C3d4_E5f6' };
            account.set({
                accounts: ['0x1234567890123456789012345678901234567890'],
                lastAccount,
            });

            account.clear();

            const state = account.get();
            expect(state.accounts).toBeUndefined();
            expect(state.lastAccount).toEqual(lastAccount);
        });
    });

    describe('chains actions', () => {
        it('should initialize with empty chains array', () => {
            const state = chains.get();
            expect(state).toEqual([]);
        });

        it('should set single chain', () => {
            chains.set([
                {
                    id: 1,
                    rpcUrl: 'https://eth.example.com',
                },
            ]);

            const state = chains.get();
            expect(state.length).toBe(1);
            expect(state[0].id).toBe(1);
        });

        it('should set multiple chains', () => {
            chains.set([
                {
                    id: 1,
                    rpcUrl: 'https://eth.example.com',
                },
                {
                    id: 11155111,
                    rpcUrl: 'https://sepolia.example.com',
                    nativeCurrency: {
                        name: 'Sepolia Ether',
                        symbol: 'ETH',
                        decimal: 18,
                    },
                },
            ]);

            const state = chains.get();
            expect(state.length).toBe(2);
            expect(state[0].id).toBe(1);
            expect(state[1].id).toBe(11155111);
            expect(state[1].nativeCurrency?.symbol).toBe('ETH');
        });

        it('should replace chains on set', () => {
            chains.set([{ id: 1 }]);
            chains.set([{ id: 2 }]);

            const state = chains.get();
            expect(state.length).toBe(1);
            expect(state[0].id).toBe(2);
        });

        it('should clear chains', () => {
            chains.set([{ id: 1 }, { id: 2 }]);

            chains.clear();

            const state = chains.get();
            expect(state).toEqual([]);
        });
    });

    describe('keys actions', () => {
        it('should initialize with empty keys object', () => {
            const key = keys.get('test');
            expect(key).toBeUndefined();
        });

        it('should set a key-value pair', () => {
            keys.set('myKey', 'myValue');

            const value = keys.get('myKey');
            expect(value).toBe('myValue');
        });

        it('should set multiple keys', () => {
            keys.set('key1', 'value1');
            keys.set('key2', 'value2');
            keys.set('key3', 'value3');

            expect(keys.get('key1')).toBe('value1');
            expect(keys.get('key2')).toBe('value2');
            expect(keys.get('key3')).toBe('value3');
        });

        it('should set key to null', () => {
            keys.set('myKey', 'myValue');
            keys.set('myKey', null);

            const value = keys.get('myKey');
            expect(value).toBeNull();
        });

        it('should override existing key', () => {
            keys.set('myKey', 'oldValue');
            keys.set('myKey', 'newValue');

            const value = keys.get('myKey');
            expect(value).toBe('newValue');
        });

        it('should return undefined for non-existent key', () => {
            const value = keys.get('nonExistent');
            expect(value).toBeUndefined();
        });

        it('should clear all keys', () => {
            keys.set('key1', 'value1');
            keys.set('key2', 'value2');

            keys.clear();

            expect(keys.get('key1')).toBeUndefined();
            expect(keys.get('key2')).toBeUndefined();
        });

        it('should preserve other keys when setting one', () => {
            keys.set('key1', 'value1');
            keys.set('key2', 'value2');
            keys.set('key3', 'value3');

            expect(keys.get('key1')).toBe('value1');
            expect(keys.get('key2')).toBe('value2');
        });
    });

    describe('config actions', () => {
        it('should initialize with SDK version', () => {
            const state = config.get();
            expect(state.version).toBe(SDK_VERSION);
        });

        it('should set config metadata', () => {
            config.set({
                metadata: {
                    appName: 'Test App',
                    appLogoUrl: 'https://example.com/logo.png',
                    defaultChainId: 1,
                },
            });

            const state = config.get();
            expect(state.metadata?.appName).toBe('Test App');
            expect(state.metadata?.defaultChainId).toBe(1);
        });

        it('should set config preference', () => {
            config.set({
                preference: {
                    mode: 'CrossPlatform',
                    keysUrl: 'https://keys.example.com',
                },
            });

            const state = config.get();
            expect(state.preference?.mode).toBe('CrossPlatform');
            expect(state.preference?.keysUrl).toBe('https://keys.example.com');
        });

        it('should merge config on set', () => {
            config.set({
                metadata: {
                    appName: 'Test App',
                    appLogoUrl: null,
                    defaultChainId: 1,
                },
            });

            config.set({
                deviceId: 'device-123',
            });

            const state = config.get();
            expect(state.metadata?.appName).toBe('Test App');
            expect(state.deviceId).toBe('device-123');
            expect(state.version).toBe(SDK_VERSION);
        });

        it('should set paymaster URLs', () => {
            config.set({
                paymasters: {
                    1: {
                        url: 'https://paymaster-mainnet.example.com',
                    },
                    11155111: {
                        url: 'https://paymaster-sepolia.example.com',
                    },
                },
            });

            const state = config.get();
            expect(state.paymasters?.[1].url).toBe('https://paymaster-mainnet.example.com');
            expect(state.paymasters?.[11155111].url).toBe('https://paymaster-sepolia.example.com');
        });

        it('should preserve version when setting other config', () => {
            const initialVersion = config.get().version;

            config.set({
                metadata: {
                    appName: 'Test App',
                    appLogoUrl: null,
                    defaultChainId: 1,
                },
            });

            const state = config.get();
            expect(state.version).toBe(initialVersion);
        });
    });

    describe('callStatuses actions', () => {
        it('should initialize with empty callStatuses object', () => {
            const status = callStatuses.get('0xbatchId');
            expect(status).toBeUndefined();
        });

        it('should set a call status as pending', () => {
            callStatuses.set('0xbatchId1', {
                status: 'pending',
                chainId: 1,
            });

            const status = callStatuses.get('0xbatchId1');
            expect(status).toBeDefined();
            expect(status?.status).toBe('pending');
            expect(status?.chainId).toBe(1);
        });

        it('should set multiple call statuses', () => {
            callStatuses.set('0xbatchId1', {
                status: 'pending',
                chainId: 1,
            });
            callStatuses.set('0xbatchId2', {
                status: 'completed',
                chainId: 1,
                receipts: [{ receipt: { transactionHash: '0xtxhash' } }],
            });
            callStatuses.set('0xbatchId3', {
                status: 'failed',
                chainId: 1,
                error: 'Transaction failed',
            });

            expect(callStatuses.get('0xbatchId1')?.status).toBe('pending');
            expect(callStatuses.get('0xbatchId2')?.status).toBe('completed');
            expect(callStatuses.get('0xbatchId3')?.status).toBe('failed');
            expect(callStatuses.get('0xbatchId3')?.error).toBe('Transaction failed');
        });

        it('should update call status', () => {
            callStatuses.set('0xbatchId1', {
                status: 'pending',
                chainId: 1,
            });

            callStatuses.update('0xbatchId1', {
                status: 'completed',
                receipts: [{ receipt: { transactionHash: '0xtxhash' } }],
            });

            const status = callStatuses.get('0xbatchId1');
            expect(status?.status).toBe('completed');
            expect(status?.chainId).toBe(1); // Should preserve existing fields
            expect(status?.receipts).toBeDefined();
        });

        it('should update only specified fields', () => {
            callStatuses.set('0xbatchId1', {
                status: 'pending',
                chainId: 1,
            });

            callStatuses.update('0xbatchId1', {
                status: 'failed',
                error: 'Transaction failed',
            });

            const status = callStatuses.get('0xbatchId1');
            expect(status?.status).toBe('failed');
            expect(status?.chainId).toBe(1); // Should preserve chainId
            expect(status?.error).toBe('Transaction failed');
        });

        it('should not update if batchId does not exist', () => {
            const initialState = sdkstore.getState().callStatuses;

            callStatuses.update('0xnonexistent', {
                status: 'completed',
            });

            // State should remain unchanged
            expect(sdkstore.getState().callStatuses).toEqual(initialState);
        });

        it('should return undefined for non-existent batchId', () => {
            const status = callStatuses.get('0xnonexistent');
            expect(status).toBeUndefined();
        });

        it('should clear all call statuses', () => {
            callStatuses.set('0xbatchId1', {
                status: 'pending',
                chainId: 1,
            });
            callStatuses.set('0xbatchId2', {
                status: 'completed',
                chainId: 1,
            });

            callStatuses.clear();

            expect(callStatuses.get('0xbatchId1')).toBeUndefined();
            expect(callStatuses.get('0xbatchId2')).toBeUndefined();
        });

        it('should preserve other call statuses when setting one', () => {
            callStatuses.set('0xbatchId1', {
                status: 'pending',
                chainId: 1,
            });
            callStatuses.set('0xbatchId2', {
                status: 'completed',
                chainId: 1,
            });

            callStatuses.set('0xbatchId3', {
                status: 'failed',
                chainId: 1,
                error: 'Error',
            });

            expect(callStatuses.get('0xbatchId1')?.status).toBe('pending');
            expect(callStatuses.get('0xbatchId2')?.status).toBe('completed');
            expect(callStatuses.get('0xbatchId3')?.status).toBe('failed');
        });

        it('should handle all three status states', () => {
            callStatuses.set('0xpending', {
                status: 'pending',
                chainId: 1,
            });
            callStatuses.set('0xcompleted', {
                status: 'completed',
                chainId: 1,
                receipts: [{ receipt: { transactionHash: '0xtxhash' } }],
            });
            callStatuses.set('0xfailed', {
                status: 'failed',
                chainId: 1,
                error: 'Transaction failed',
            });

            expect(callStatuses.get('0xpending')?.status).toBe('pending');
            expect(callStatuses.get('0xcompleted')?.status).toBe('completed');
            expect(callStatuses.get('0xcompleted')?.receipts).toBeDefined();
            expect(callStatuses.get('0xfailed')?.status).toBe('failed');
            expect(callStatuses.get('0xfailed')?.error).toBe('Transaction failed');
        });
    });

    describe('store integration', () => {
        it('should export combined store with actions', () => {
            expect(store.account).toBeDefined();
            expect(store.chains).toBeDefined();
            expect(store.keys).toBeDefined();
            expect(store.config).toBeDefined();
            expect(store.callStatuses).toBeDefined();
            expect(store.getState).toBeDefined();
            expect(store.setState).toBeDefined();
            expect(store.subscribe).toBeDefined();
        });

        it('should allow direct state access via sdkstore', () => {
            chains.set([{ id: 1 }]);
            account.set({ accounts: ['0x1234567890123456789012345678901234567890'] });

            const state = sdkstore.getState();
            expect(state.chains.length).toBe(1);
            expect(state.account.accounts?.length).toBe(1);
        });

        it('should support subscriptions', () => {
            let callCount = 0;
            const unsubscribe = sdkstore.subscribe(() => {
                callCount++;
            });

            chains.set([{ id: 1 }]);
            account.set({ accounts: ['0x1234567890123456789012345678901234567890'] });

            expect(callCount).toBeGreaterThan(0);
            unsubscribe();
        });

        it('should maintain data consistency across different action APIs', () => {
            // Set data using action APIs
            chains.set([{ id: 1 }]);
            keys.set('test', 'value');

            // Read using direct store access
            const state = store.getState();
            expect(state.chains[0].id).toBe(1);
            expect(state.keys.test).toBe('value');

            // Verify using action APIs
            expect(chains.get()[0].id).toBe(1);
            expect(keys.get('test')).toBe('value');
        });
    });

    // keys.jaw.id is one origin shared by every dApp in popup mode, and the config
    // slice is persisted wholesale. A dappOrigin surviving there would greet the
    // next dApp's document holding the previous one's origin.
    describe('what the config slice persists', () => {
        it('leaves the calling dApp out of storage', () => {
            store.config.set({ apiKey: 'k1', dappOrigin: 'https://dapp.example' });

            const persisted = sdkstore.persist.getOptions().partialize?.(sdkstore.getState());

            expect(persisted?.config.apiKey).toBe('k1');
            expect(persisted?.config).not.toHaveProperty('dappOrigin');
            expect(store.config.get().dappOrigin).toBe('https://dapp.example');
        });
    });

    describe('state isolation', () => {
        it('should not affect other slices when updating one', () => {
            chains.set([{ id: 1 }]);
            keys.set('key1', 'value1');
            account.set({ accounts: ['0x1234567890123456789012345678901234567890'] });
            callStatuses.set('0xbatchId', {
                status: 'pending',
                chainId: 1,
            });

            // Update only chains
            chains.set([{ id: 2 }]);

            // Other slices should remain unchanged
            expect(keys.get('key1')).toBe('value1');
            expect(account.get().accounts?.length).toBe(1);
            expect(callStatuses.get('0xbatchId')?.status).toBe('pending');
        });

        it('should clear only targeted slice', () => {
            chains.set([{ id: 1 }]);
            keys.set('key1', 'value1');
            account.set({ accounts: ['0x1234567890123456789012345678901234567890'] });
            callStatuses.set('0xbatchId', {
                status: 'pending',
                chainId: 1,
            });

            // Clear only keys
            keys.clear();

            // Keys should be empty
            expect(keys.get('key1')).toBeUndefined();

            // Other slices should remain
            expect(chains.get().length).toBe(1);
            expect(account.get().accounts?.length).toBe(1);
            expect(callStatuses.get('0xbatchId')?.status).toBe('pending');
        });
    });
});
