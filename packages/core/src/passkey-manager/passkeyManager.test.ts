import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PasskeyManager } from './passkeyManager.js';
import { createMemoryStorage } from '../storage-manager/index.js';
import type { PasskeyAccount } from './types.js';
import * as utils from './utils.js';
import type { AccountRecord } from '../account/accountRecord.js';

// Mock the backend utility functions
vi.spyOn(utils, 'registerPasskeyInBackend').mockResolvedValue(undefined);
vi.spyOn(utils, 'lookupPasskeyFromBackend').mockResolvedValue({
    credentialId: 'MMYq3VdLd4sfsf3hHWKYAjOuc70',
    publicKey: '0x04a1b2c3d4e5f6071829384756',
    displayName: 'test.justan.id',
});

const RECORD: AccountRecord = {
    address: '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62',
    version: 1,
    factory: '0x5803c076563C85799989d42Fc00292A8aE52fa9E',
    owners: ['0x01', '0x02'],
    nonce: '0',
};

describe('PasskeyManager', () => {
    let manager: PasskeyManager;

    const mockAddress = '0x742D35CC6634c0532925A3b844BC9E7595F0BEb0';
    const mockCredentialId = 'MMYq3VdLd4sfsf3hHWKYAjOuc70';
    const mockUsername = 'test.justan.id';
    const mockPublicKey = '0x04a1b2c3d4e5f6071829384756' as `0x${string}`;

    beforeEach(() => {
        // Use memory storage for tests to avoid localStorage side effects
        const storage = createMemoryStorage();
        manager = new PasskeyManager(storage);
    });

    describe('checkAuth', () => {
        it('should return not authenticated by default', () => {
            const result = manager.checkAuth();
            expect(result.isAuthenticated).toBe(false);
            expect(result.address).toBeUndefined();
        });

        it('should return authenticated when auth state exists', () => {
            manager.storeAuthState(mockAddress, mockCredentialId);

            const result = manager.checkAuth();
            expect(result.isAuthenticated).toBe(true);
            expect(result.address).toBe(mockAddress);
        });

        it('should return not authenticated when address is missing', () => {
            const storage = createMemoryStorage();
            storage.setItem('authState', {
                isLoggedIn: true,
                credentialId: mockCredentialId,
                // address missing
            });

            const testManager = new PasskeyManager(storage);
            const result = testManager.checkAuth();
            expect(result.isAuthenticated).toBe(false);
        });

        it('should return not authenticated when isLoggedIn is false', () => {
            const storage = createMemoryStorage();
            storage.setItem('authState', {
                isLoggedIn: false,
                address: mockAddress,
                credentialId: mockCredentialId,
            });

            const testManager = new PasskeyManager(storage);
            const result = testManager.checkAuth();
            expect(result.isAuthenticated).toBe(false);
        });

        it('should handle storage errors gracefully', () => {
            interface MockStorage {
                getItem: () => void;
                setItem: () => void;
                removeItem: () => void;
            }

            const brokenStorage: MockStorage = {
                getItem: () => {
                    throw new Error('Storage error');
                },
                setItem: vi.fn(),
                removeItem: vi.fn(),
            };

            const testManager = new PasskeyManager(brokenStorage as never);
            const result = testManager.checkAuth();
            expect(result.isAuthenticated).toBe(false);
        });
    });

    describe('storeAuthState', () => {
        it('should store auth state with all required fields', () => {
            manager.storeAuthState(mockAddress, mockCredentialId);

            const result = manager.checkAuth();
            expect(result.isAuthenticated).toBe(true);
            expect(result.address).toBe(mockAddress);

            const credentialId = manager.fetchActiveCredentialId();
            expect(credentialId).toBe(mockCredentialId);
        });

        it('should overwrite existing auth state', () => {
            manager.storeAuthState(mockAddress, mockCredentialId);

            const newAddress = '0x1111111111111111111111111111111111111111';
            const newCredentialId = 'newCredId123';
            manager.storeAuthState(newAddress, newCredentialId);

            const result = manager.checkAuth();
            expect(result.address).toBe(newAddress);
            expect(manager.fetchActiveCredentialId()).toBe(newCredentialId);
        });
    });

    describe('logout', () => {
        it('should clear auth state', () => {
            manager.storeAuthState(mockAddress, mockCredentialId);
            expect(manager.checkAuth().isAuthenticated).toBe(true);

            manager.logout();
            expect(manager.checkAuth().isAuthenticated).toBe(false);
        });

        it('should not affect accounts list', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);
            expect(manager.fetchAccounts().length).toBe(1);

            manager.logout();
            expect(manager.fetchAccounts().length).toBe(1);
        });

        it('should throw error if storage fails', () => {
            interface MockStorage {
                getItem: () => null;
                setItem: () => void;
                removeItem: () => void;
            }

            const brokenStorage: MockStorage = {
                getItem: () => null,
                setItem: vi.fn(),
                removeItem: () => {
                    throw new Error('Storage error');
                },
            };

            const testManager = new PasskeyManager(brokenStorage as never);
            expect(() => testManager.logout()).toThrow('Storage error');
        });
    });

    describe('fetchAccounts', () => {
        it('should return empty array when no accounts exist', () => {
            const accounts = manager.fetchAccounts();
            expect(accounts).toEqual([]);
        });

        it('should return all stored accounts', () => {
            const account1: PasskeyAccount = {
                username: 'user1.justan.id',
                credentialId: 'cred1',
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            };

            const account2: PasskeyAccount = {
                username: 'user2.justan.id',
                credentialId: 'cred2',
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: true,
            };

            manager.addAccountToList(account1);
            manager.addAccountToList(account2);

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(2);
            expect(accounts).toContainEqual(account1);
            expect(accounts).toContainEqual(account2);
        });

        it('should handle storage errors gracefully', () => {
            interface MockStorage {
                getItem: () => void;
                setItem: () => void;
                removeItem: () => void;
            }

            const brokenStorage: MockStorage = {
                getItem: () => {
                    throw new Error('Storage error');
                },
                setItem: vi.fn(),
                removeItem: vi.fn(),
            };

            const testManager = new PasskeyManager(brokenStorage as never);
            const accounts = testManager.fetchAccounts();
            expect(accounts).toEqual([]);
        });

        it('should handle invalid data gracefully', () => {
            const storage = createMemoryStorage();
            storage.setItem('accounts', 'invalid data');

            const testManager = new PasskeyManager(storage);
            const accounts = testManager.fetchAccounts();
            expect(accounts).toEqual([]);
        });
    });

    describe('fetchActiveCredentialId', () => {
        it('should return null when no auth state exists', () => {
            const credentialId = manager.fetchActiveCredentialId();
            expect(credentialId).toBeNull();
        });

        it('should return active credential ID', () => {
            manager.storeAuthState(mockAddress, mockCredentialId);

            const credentialId = manager.fetchActiveCredentialId();
            expect(credentialId).toBe(mockCredentialId);
        });

        it('should handle storage errors gracefully', () => {
            interface MockStorage {
                getItem: () => void;
                setItem: () => void;
                removeItem: () => void;
            }

            const brokenStorage: MockStorage = {
                getItem: () => {
                    throw new Error('Storage error');
                },
                setItem: vi.fn(),
                removeItem: vi.fn(),
            };

            const testManager = new PasskeyManager(brokenStorage as never);
            const credentialId = testManager.fetchActiveCredentialId();
            expect(credentialId).toBeNull();
        });
    });

    describe('addAccountToList', () => {
        it('should add new account', () => {
            const account: PasskeyAccount = {
                username: mockUsername,
                credentialId: mockCredentialId,
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            };

            manager.addAccountToList(account);

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0]).toEqual(account);
        });

        it('should not add duplicate accounts', () => {
            const account: PasskeyAccount = {
                username: mockUsername,
                credentialId: mockCredentialId,
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            };

            manager.addAccountToList(account);
            manager.addAccountToList(account);

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
        });

        it('should allow accounts with different credential IDs', () => {
            const account1: PasskeyAccount = {
                username: 'user1.justan.id',
                credentialId: 'cred1',
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            };

            const account2: PasskeyAccount = {
                username: 'user2.justan.id',
                credentialId: 'cred2',
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            };

            manager.addAccountToList(account1);
            manager.addAccountToList(account2);

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(2);
        });

        it('fills in the address when re-adding an existing account that had none (create path)', () => {
            // createPasskey stores the account first, before the address is derived.
            const withoutAddress: PasskeyAccount = {
                username: mockUsername,
                credentialId: mockCredentialId,
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            };
            manager.addAccountToList(withoutAddress);
            expect(manager.fetchAccounts()[0].address).toBeUndefined();

            // storePasskeyAccount re-adds the same credential once the address is known.
            manager.addAccountToList({ ...withoutAddress, address: mockAddress });

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0].address).toBe(mockAddress);
        });

        it('does not overwrite an address the stored account already has', () => {
            manager.addAccountToList({
                username: mockUsername,
                credentialId: mockCredentialId,
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
                address: mockAddress,
            });
            manager.addAccountToList({
                username: mockUsername,
                credentialId: mockCredentialId,
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
                address: '0x0000000000000000000000000000000000000001',
            });

            expect(manager.fetchAccounts()[0].address).toBe(mockAddress);
        });
    });

    describe('setAccountAddresses', () => {
        const makeAccount = (credentialId: string): PasskeyAccount => ({
            username: `${credentialId}.justan.id`,
            credentialId,
            publicKey: mockPublicKey,
            creationDate: new Date().toISOString(),
            isImported: false,
        });

        it('persists every address in a single batched write (no lost writes)', () => {
            manager.addAccountToList(makeAccount('credA'));
            manager.addAccountToList(makeAccount('credB'));

            // The pre-fix code issued one read-modify-write per address; concurrent
            // backfill completions would clobber each other. A single batched write
            // must land both.
            manager.setAccountAddresses([
                { credentialId: 'credA', address: '0x00000000000000000000000000000000000000AA' },
                { credentialId: 'credB', address: '0x00000000000000000000000000000000000000BB' },
            ]);

            const accounts = manager.fetchAccounts();
            expect(accounts.find((a) => a.credentialId === 'credA')?.address).toBe(
                '0x00000000000000000000000000000000000000AA'
            );
            expect(accounts.find((a) => a.credentialId === 'credB')?.address).toBe(
                '0x00000000000000000000000000000000000000BB'
            );
        });

        it('does not overwrite an address that is already set', () => {
            manager.addAccountToList({ ...makeAccount('credA'), address: mockAddress });
            manager.setAccountAddresses([
                { credentialId: 'credA', address: '0x00000000000000000000000000000000000000AA' },
            ]);
            expect(manager.fetchAccounts()[0].address).toBe(mockAddress);
        });

        it('fills a missing account record alongside the address', () => {
            manager.addAccountToList(makeAccount('credA'));
            manager.setAccountAddresses([{ credentialId: 'credA', address: RECORD.address, account: RECORD }]);
            expect(manager.fetchAccounts()[0]).toMatchObject({ address: RECORD.address, account: RECORD });
        });

        it('fills a missing record on an entry whose address is already set, keeping the address', () => {
            manager.addAccountToList({ ...makeAccount('credA'), address: mockAddress });
            manager.setAccountAddresses([{ credentialId: 'credA', address: RECORD.address, account: RECORD }]);
            expect(manager.fetchAccounts()[0]).toMatchObject({ address: mockAddress, account: RECORD });
        });

        it('does not overwrite a record that is already set', () => {
            const stored = { ...RECORD, nonce: '7' };
            manager.addAccountToList({ ...makeAccount('credA'), address: RECORD.address, account: stored });
            manager.setAccountAddresses([{ credentialId: 'credA', address: RECORD.address, account: RECORD }]);
            expect(manager.fetchAccounts()[0].account).toEqual(stored);
        });

        it('is a no-op for an empty batch or unknown credentials', () => {
            manager.addAccountToList(makeAccount('credA'));
            manager.setAccountAddresses([]);
            manager.setAccountAddresses([
                { credentialId: 'missing', address: '0x00000000000000000000000000000000000000AA' },
            ]);
            expect(manager.fetchAccounts()[0].address).toBeUndefined();
        });
    });

    describe('account records', () => {
        it('storePasskeyAccount stores the record it is given', async () => {
            await manager.storePasskeyAccount(
                mockUsername,
                mockCredentialId,
                mockPublicKey,
                mockAddress,
                false,
                RECORD
            );
            expect(manager.getAccountByCredentialId(mockCredentialId)?.account).toEqual(RECORD);
        });

        it('storePasskeyAccount stores no record field when given none', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);
            expect(manager.getAccountByCredentialId(mockCredentialId)).not.toHaveProperty('account');
        });

        it('storePasskeyAccountForLogin stores the record it is given', async () => {
            await manager.storePasskeyAccountForLogin(mockCredentialId, mockAddress, false, RECORD);
            expect(manager.getAccountByCredentialId(mockCredentialId)?.account).toEqual(RECORD);
        });

        it('addAccountToList fills a missing record on an existing entry', () => {
            const entry: PasskeyAccount = {
                username: mockUsername,
                credentialId: mockCredentialId,
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            };
            manager.addAccountToList(entry);
            manager.addAccountToList({ ...entry, account: RECORD });
            expect(manager.fetchAccounts()[0].account).toEqual(RECORD);
        });

        it('fetchAccountRecord asks the JAW server for the credential, with the api key, when none is configured', async () => {
            const spy = vi.spyOn(utils, 'fetchAccountRecordFromBackend').mockResolvedValue(RECORD);
            const keyed = new PasskeyManager(createMemoryStorage(), undefined, 'k1');

            await expect(keyed.fetchAccountRecord(mockCredentialId)).resolves.toEqual(RECORD);
            expect(spy).toHaveBeenCalledWith(mockCredentialId, 'k1', false, undefined);
        });

        it('fetchAccountRecord passes on a configured passkey server', async () => {
            const spy = vi.spyOn(utils, 'fetchAccountRecordFromBackend').mockResolvedValue(RECORD);
            const custom = new PasskeyManager(createMemoryStorage(), {
                serverUrl: 'https://passkeys.example.com/passkeys',
            });

            await custom.fetchAccountRecord(mockCredentialId);
            expect(spy).toHaveBeenCalledWith(
                mockCredentialId,
                undefined,
                false,
                'https://passkeys.example.com/passkeys'
            );
        });
    });

    describe('storePasskeyAccount', () => {
        it('should register with backend and store account locally', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            // Check auth state
            const auth = manager.checkAuth();
            expect(auth.isAuthenticated).toBe(true);
            expect(auth.address).toBe(mockAddress);

            // Check account stored
            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0].username).toBe(mockUsername);
            expect(accounts[0].credentialId).toBe(mockCredentialId);
            expect(accounts[0].isImported).toBe(false);
        });

        it('should trim whitespace from username', async () => {
            await manager.storePasskeyAccount('  test.justan.id  ', mockCredentialId, mockPublicKey, mockAddress);

            const accounts = manager.fetchAccounts();
            expect(accounts[0].username).toBe('test.justan.id');
        });

        it('persists the address on the stored account entry, even when it was pre-added without one', async () => {
            // Reproduce the create path: createPasskey adds the account before the
            // address is derived, then storePasskeyAccount re-adds it with the address.
            manager.addAccountToList({
                username: mockUsername,
                credentialId: mockCredentialId,
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            });

            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0].address).toBe(mockAddress);
        });

        it('should set isImported to false', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            const accounts = manager.fetchAccounts();
            expect(accounts[0].isImported).toBe(false);
        });

        it('should set creation date', async () => {
            const beforeTime = new Date().toISOString();
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);
            const afterTime = new Date().toISOString();

            const accounts = manager.fetchAccounts();
            const creationDate = accounts[0].creationDate;
            expect(creationDate).toBeDefined();
            expect(creationDate >= beforeTime).toBe(true);
            expect(creationDate <= afterTime).toBe(true);
        });
    });

    describe('storePasskeyAccountForLogin', () => {
        it('should lookup passkey from backend and store with isImported=true', async () => {
            await manager.storePasskeyAccountForLogin(mockCredentialId, mockAddress);

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0].isImported).toBe(true);
        });

        it('should set auth state', async () => {
            await manager.storePasskeyAccountForLogin(mockCredentialId, mockAddress);

            const auth = manager.checkAuth();
            expect(auth.isAuthenticated).toBe(true);
            expect(auth.address).toBe(mockAddress);
        });

        it('should store username from backend lookup', async () => {
            await manager.storePasskeyAccountForLogin(mockCredentialId, mockAddress);

            const accounts = manager.fetchAccounts();
            expect(accounts[0].username).toBe(mockUsername);
        });
    });

    describe('removeAccount', () => {
        it('should remove account by credential ID', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);
            expect(manager.fetchAccounts().length).toBe(1);

            manager.removeAccount(mockCredentialId);
            expect(manager.fetchAccounts().length).toBe(0);
        });

        it('should not affect other accounts', async () => {
            await manager.storePasskeyAccount('user1.justan.id', 'cred1', mockPublicKey, mockAddress);
            await manager.storePasskeyAccount('user2.justan.id', 'cred2', mockPublicKey, mockAddress);

            manager.removeAccount('cred1');

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0].credentialId).toBe('cred2');
        });

        it('should do nothing if credential does not exist', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            manager.removeAccount('non-existent-id');

            expect(manager.fetchAccounts().length).toBe(1);
        });

        it('should clear auth state when removing active account', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);
            expect(manager.checkAuth().isAuthenticated).toBe(true);

            manager.removeAccount(mockCredentialId);
            expect(manager.checkAuth().isAuthenticated).toBe(false);
        });
    });

    describe('clearAll', () => {
        it('should clear auth state and accounts', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);
            await manager.storePasskeyAccount('user2.justan.id', 'cred2', mockPublicKey, mockAddress);

            expect(manager.checkAuth().isAuthenticated).toBe(true);
            expect(manager.fetchAccounts().length).toBe(2);

            manager.clearAll();

            expect(manager.checkAuth().isAuthenticated).toBe(false);
            expect(manager.fetchAccounts().length).toBe(0);
        });

        it('should work when no data exists', () => {
            expect(() => manager.clearAll()).not.toThrow();
        });
    });

    describe('getAccountByCredentialId', () => {
        it('should return account when it exists', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            const account = manager.getAccountByCredentialId(mockCredentialId);
            expect(account).toBeDefined();
            expect(account?.username).toBe(mockUsername);
            expect(account?.credentialId).toBe(mockCredentialId);
        });

        it('should return undefined when account does not exist', () => {
            const account = manager.getAccountByCredentialId('non-existent');
            expect(account).toBeUndefined();
        });

        it('should find correct account among multiple', async () => {
            await manager.storePasskeyAccount('user1.justan.id', 'cred1', mockPublicKey, mockAddress);
            await manager.storePasskeyAccount('user2.justan.id', 'cred2', mockPublicKey, mockAddress);

            const account = manager.getAccountByCredentialId('cred2');
            expect(account?.username).toBe('user2.justan.id');
        });
    });

    describe('hasAccount', () => {
        it('should return true when account exists', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            expect(manager.hasAccount(mockCredentialId)).toBe(true);
        });

        it('should return false when account does not exist', () => {
            expect(manager.hasAccount('non-existent')).toBe(false);
        });
    });

    describe('getCurrentAccount', () => {
        it('should return undefined when not authenticated', () => {
            const account = manager.getCurrentAccount();
            expect(account).toBeUndefined();
        });

        it('should return current account when authenticated', async () => {
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            const account = manager.getCurrentAccount();
            expect(account).toBeDefined();
            expect(account?.username).toBe(mockUsername);
            expect(account?.credentialId).toBe(mockCredentialId);
        });

        it('should return correct account after switching', async () => {
            await manager.storePasskeyAccount(
                'user1.justan.id',
                'cred1',
                mockPublicKey,
                '0x1111111111111111111111111111111111111111'
            );
            await manager.storePasskeyAccount(
                'user2.justan.id',
                'cred2',
                mockPublicKey,
                '0x2222222222222222222222222222222222222222'
            );

            let account = manager.getCurrentAccount();
            expect(account?.username).toBe('user2.justan.id');

            manager.storeAuthState('0x1111111111111111111111111111111111111111', 'cred1');
            account = manager.getCurrentAccount();
            expect(account?.username).toBe('user1.justan.id');
        });
    });

    describe('validation', () => {
        it('should throw error for empty display name', async () => {
            await expect(
                manager.storePasskeyAccount('   ', mockCredentialId, mockPublicKey, mockAddress)
            ).rejects.toThrow('Display name cannot be empty');
        });

        it('should throw error for display name exceeding 100 characters', async () => {
            const longName = 'a'.repeat(101);
            await expect(
                manager.storePasskeyAccount(longName, mockCredentialId, mockPublicKey, mockAddress)
            ).rejects.toThrow('Display name cannot exceed 100 characters');
        });

        it('should accept valid public key with uppercase hex', async () => {
            await manager.storePasskeyAccount(
                mockUsername,
                mockCredentialId,
                '0x04A1B2C3D4E5F6071829384756' as `0x${string}`,
                mockAddress
            );

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0].publicKey).toBe('0x04A1B2C3D4E5F6071829384756');
        });
    });

    describe('getPreference', () => {
        it('should return empty preference by default', () => {
            const preference = manager.getPreference();
            expect(preference).toEqual({});
        });

        it('should return preference passed in constructor', () => {
            const customPreference = {
                keysUrl: 'https://custom-keys.example.com',
                serverUrl: 'https://custom.example.com',
            };

            const customManager = new PasskeyManager(createMemoryStorage(), customPreference);
            const preference = customManager.getPreference();

            expect(preference.keysUrl).toBe('https://custom-keys.example.com');
            expect(preference.serverUrl).toBe('https://custom.example.com');
        });

        it('should return copy of preference', () => {
            const customPreference = { serverUrl: 'https://example.com' };
            const customManager = new PasskeyManager(createMemoryStorage(), customPreference);

            const preference1 = customManager.getPreference();
            preference1.serverUrl = 'modified';

            const preference2 = customManager.getPreference();
            expect(preference2.serverUrl).toBe('https://example.com');
        });
    });

    describe('updatePreference', () => {
        it('should update preference', () => {
            manager.updatePreference({ serverUrl: 'https://new.example.com' });

            const preference = manager.getPreference();
            expect(preference.serverUrl).toBe('https://new.example.com');
        });

        it('should merge with existing preference', () => {
            manager.updatePreference({ serverUrl: 'https://example.com' });
            manager.updatePreference({ keysUrl: 'https://custom-keys.example.com' });

            const preference = manager.getPreference();
            expect(preference.serverUrl).toBe('https://example.com');
            expect(preference.keysUrl).toBe('https://custom-keys.example.com');
        });

        it('should overwrite existing values', () => {
            manager.updatePreference({ serverUrl: 'https://old.example.com' });
            manager.updatePreference({ serverUrl: 'https://new.example.com' });

            const preference = manager.getPreference();
            expect(preference.serverUrl).toBe('https://new.example.com');
        });
    });

    describe('integration scenarios', () => {
        it('should handle complete registration flow', async () => {
            // Initial state
            expect(manager.checkAuth().isAuthenticated).toBe(false);
            expect(manager.fetchAccounts().length).toBe(0);

            // Register
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);

            // Verify state
            const auth = manager.checkAuth();
            expect(auth.isAuthenticated).toBe(true);
            expect(auth.address).toBe(mockAddress);

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0].username).toBe(mockUsername);

            const activeCredId = manager.fetchActiveCredentialId();
            expect(activeCredId).toBe(mockCredentialId);
        });

        it('should handle login flow', async () => {
            await manager.storePasskeyAccountForLogin(mockCredentialId, mockAddress);

            expect(manager.checkAuth().isAuthenticated).toBe(true);
            expect(manager.fetchAccounts()[0].isImported).toBe(true);
        });

        it('should handle logout and re-login', async () => {
            // Initial login
            await manager.storePasskeyAccount(mockUsername, mockCredentialId, mockPublicKey, mockAddress);
            expect(manager.checkAuth().isAuthenticated).toBe(true);

            // Logout
            manager.logout();
            expect(manager.checkAuth().isAuthenticated).toBe(false);

            // Account should still exist
            expect(manager.fetchAccounts().length).toBe(1);

            // Re-login
            manager.storeAuthState(mockAddress, mockCredentialId);
            expect(manager.checkAuth().isAuthenticated).toBe(true);
        });

        it('should handle multiple accounts', async () => {
            await manager.storePasskeyAccount(
                'user1.justan.id',
                'cred1',
                mockPublicKey,
                '0x1111111111111111111111111111111111111111'
            );
            await manager.storePasskeyAccount(
                'user2.justan.id',
                'cred2',
                mockPublicKey,
                '0x2222222222222222222222222222222222222222'
            );
            await manager.storePasskeyAccountForLogin('cred3', '0x3333333333333333333333333333333333333333');

            const accounts = manager.fetchAccounts();
            expect(accounts.length).toBe(3);
            expect(accounts.filter((a) => a.isImported).length).toBe(1);
            expect(accounts.filter((a) => !a.isImported).length).toBe(2);
        });

        it('should handle account switching', async () => {
            await manager.storePasskeyAccount(
                'user1.justan.id',
                'cred1',
                mockPublicKey,
                '0x1111111111111111111111111111111111111111'
            );
            expect(manager.checkAuth().address).toBe('0x1111111111111111111111111111111111111111');
            expect(manager.fetchActiveCredentialId()).toBe('cred1');

            manager.storeAuthState('0x2222222222222222222222222222222222222222', 'cred2');
            manager.addAccountToList({
                username: 'user2.justan.id',
                credentialId: 'cred2',
                publicKey: mockPublicKey,
                creationDate: new Date().toISOString(),
                isImported: false,
            });

            expect(manager.checkAuth().address).toBe('0x2222222222222222222222222222222222222222');
            expect(manager.fetchActiveCredentialId()).toBe('cred2');
            expect(manager.fetchAccounts().length).toBe(2);
        });
    });

    describe('React Native adapter support', () => {
        it('createPasskey should forward createFn, nativeCreateFn, and getFn to utils', async () => {
            const mockCreateFn = vi.fn();
            const mockNativeCreateFn = vi.fn().mockResolvedValue({
                id: 'native-cred',
                publicKey: '0x04native' as `0x${string}`,
            });
            const mockGetFn = vi.fn();

            vi.spyOn(utils, 'createPasskeyUtils').mockResolvedValue({
                credentialId: 'native-cred',
                publicKey: '0x04native' as `0x${string}`,
                webAuthnAccount: { type: 'webAuthn' } as never,
            });

            await manager.createPasskey('alice', 'example.com', 'MyApp', mockCreateFn, mockNativeCreateFn, mockGetFn);

            expect(utils.createPasskeyUtils).toHaveBeenCalledWith(
                'alice',
                'example.com',
                'MyApp',
                mockCreateFn,
                mockNativeCreateFn,
                mockGetFn
            );
        });

        it('createPasskey should store the account locally after native creation', async () => {
            vi.spyOn(utils, 'createPasskeyUtils').mockResolvedValue({
                credentialId: 'rn-cred-id',
                publicKey: '0x04rnpub' as `0x${string}`,
                webAuthnAccount: { type: 'webAuthn' } as never,
            });

            const result = await manager.createPasskey(
                'bob',
                'example.com',
                'MyApp',
                undefined,
                vi.fn().mockResolvedValue({ id: 'rn-cred-id', publicKey: '0x04rnpub' })
            );

            expect(result.passkeyAccount.username).toBe('bob');
            expect(result.passkeyAccount.credentialId).toBe('rn-cred-id');
            expect(result.passkeyAccount.publicKey).toBe('0x04rnpub');
            expect(result.passkeyAccount.isImported).toBe(false);

            // Should be stored
            const accounts = manager.fetchAccounts();
            expect(accounts).toHaveLength(1);
            expect(accounts[0].credentialId).toBe('rn-cred-id');
        });

        it('authenticateWithWebAuthn should forward getFn to utils', async () => {
            const mockGetFn = vi.fn();
            const mockResult = {
                credential: { id: 'cred-123', type: 'public-key' },
                challenge: new Uint8Array(32),
            };

            vi.spyOn(utils, 'authenticateWithWebAuthnUtils').mockResolvedValue(mockResult);

            const result = await manager.authenticateWithWebAuthn('example.com', 'cred-123', undefined, mockGetFn);

            expect(utils.authenticateWithWebAuthnUtils).toHaveBeenCalledWith(
                'example.com',
                'cred-123',
                undefined,
                mockGetFn
            );
            expect(result).toBe(mockResult);
        });

        it('importPasskeyAccount should forward getFn and rpId to utils', async () => {
            const mockGetFn = vi.fn();
            const mockResult = {
                name: 'imported',
                credential: { id: 'imp-cred', publicKey: '0x04imp' as `0x${string}` },
            };

            vi.spyOn(utils, 'importPasskeyUtils').mockResolvedValue(mockResult);

            const result = await manager.importPasskeyAccount(mockGetFn, 'myapp.com');

            // No serverUrl configured: the lookup goes to the JAW passkeys route.
            expect(utils.importPasskeyUtils).toHaveBeenCalledWith(mockGetFn, 'myapp.com', undefined, undefined);
            expect(result).toBe(mockResult);
        });

        it('importPasskeyAccount forwards a configured passkey server', async () => {
            vi.spyOn(utils, 'importPasskeyUtils').mockResolvedValue({
                name: 'imported',
                credential: { id: 'imp-cred', publicKey: '0x04imp' as `0x${string}` },
            });
            const custom = new PasskeyManager(createMemoryStorage(), {
                serverUrl: 'https://passkeys.example.com/passkeys',
            });

            await custom.importPasskeyAccount(undefined, 'myapp.com');

            expect(utils.importPasskeyUtils).toHaveBeenCalledWith(
                undefined,
                'myapp.com',
                undefined,
                'https://passkeys.example.com/passkeys'
            );
        });
    });
});
