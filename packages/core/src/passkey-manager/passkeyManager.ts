import { createLocalStorage, type SyncStorage } from '../storage-manager/index.js';
import { Address } from 'viem';
import { PasskeyAccount, AuthCheckResult, AuthState } from './types.js';
import type { JawProviderPreference } from '../provider/index.js';
import {
    registerPasskeyInBackend,
    lookupPasskeyFromBackend,
    fetchAccountRecordFromBackend,
    WebAuthnAuthenticationResult,
    authenticateWithWebAuthnUtils,
    createPasskeyUtils,
    ImportWebAuthnAuthenticationResult,
    importPasskeyUtils,
    type PasskeyCreateFn,
    type PasskeyGetFn,
    type InternalNativeCreateFn,
} from './utils.js';
import type { WebAuthnAccount } from 'viem/account-abstraction';
import type { AccountRecord } from '../account/accountRecord.js';

/**
 * PasskeyManager handles passkey authentication and account management
 *
 * Features:
 * - Manages passkey authentication state
 * - Stores and retrieves passkey credentials and accounts
 * - Supports multiple passkey accounts per user
 * - Validates credential IDs, addresses, and input formats
 *
 * Storage Keys:
 * - authState: Current authentication state
 * - accounts: Array of all passkey accounts
 */
export class PasskeyManager {
    private storage: SyncStorage;
    private preference: JawProviderPreference;
    private apiKey?: string;
    private static readonly CREDENTIAL_ID_REGEX = /^[A-Za-z0-9_-]+$/;

    constructor(storage?: SyncStorage, preference?: JawProviderPreference, apiKey?: string) {
        this.storage = storage ?? createLocalStorage('jaw', 'passkey');
        this.preference = preference ?? {};
        this.apiKey = apiKey;
    }

    /**
     * Check if user is authenticated
     */
    checkAuth(): AuthCheckResult {
        try {
            const authState = this.storage.getItem<AuthState>('authState');
            if (!authState?.isLoggedIn || !authState?.address) {
                return { isAuthenticated: false };
            }

            return {
                isAuthenticated: true,
                address: authState.address,
            };
        } catch (error) {
            console.error('Error checking auth state:', error);
            return { isAuthenticated: false };
        }
    }

    /**
     * Store authentication state
     */
    storeAuthState(address: Address, credentialId: string): void {
        this.validateCredentialId(credentialId);

        const authState: AuthState = {
            isLoggedIn: true,
            address,
            credentialId,
        };

        this.storage.setItem('authState', authState);
    }

    /**
     * Clear authentication state (logout)
     */
    logout(): void {
        try {
            this.storage.removeItem('authState');
        } catch (error) {
            console.error('Error during logout:', error);
            throw error;
        }
    }

    /**
     * Get all stored passkey accounts
     */
    fetchAccounts(): PasskeyAccount[] {
        try {
            const accounts = this.storage.getItem<PasskeyAccount[]>('accounts');
            return Array.isArray(accounts) ? accounts : [];
        } catch (error) {
            console.error('Error fetching accounts:', error);
            return [];
        }
    }

    /**
     * Get the currently active credential ID
     */
    fetchActiveCredentialId(): string | null {
        try {
            const authState = this.storage.getItem<AuthState>('authState');
            return authState?.credentialId ?? null;
        } catch (error) {
            console.error('Error fetching credential ID:', error);
            return null;
        }
    }

    /**
     * Add a passkey account to the stored list
     * If account already exists (by credentialId), fills in any fields the
     * stored entry is missing (isImported once true, and the address once known)
     */
    addAccountToList(account: PasskeyAccount): void {
        const existingAccounts = this.fetchAccounts();

        // Check if account already exists
        const existingIndex = existingAccounts.findIndex(
            (existingAccount) => existingAccount.credentialId === account.credentialId
        );

        if (existingIndex === -1) {
            const updated = [...existingAccounts, account];
            this.storage.setItem('accounts', updated);
            return;
        }

        // Merge fields the stored entry lacks. The create path adds the account
        // via createPasskey (no address yet), then re-adds it here once the
        // address is derived — so the address must be filled in on the existing
        // entry rather than dropped.
        const existing = existingAccounts[existingIndex];
        const patch: Partial<PasskeyAccount> = {};
        if (account.isImported && !existing.isImported) patch.isImported = true;
        if (account.address && !existing.address) patch.address = account.address;
        if (account.account && !existing.account) patch.account = account.account;

        if (Object.keys(patch).length === 0) return;

        const updated = existingAccounts.map((acc, i) => (i === existingIndex ? { ...acc, ...patch } : acc));
        this.storage.setItem('accounts', updated);
    }

    /**
     * Persist the address for a stored account that predates address
     * persistence. No-op when the account is missing or already has one.
     */
    setAccountAddress(credentialId: string, address: `0x${string}`): void {
        this.setAccountAddresses([{ credentialId, address }]);
    }

    /**
     * Persist addresses, and account records when given, for several stored
     * accounts in a single read-modify-write. Only fills what an entry lacks.
     * Callers that derive addresses concurrently must batch through here: issuing
     * one `setAccountAddress` per result races the reads and loses writes.
     */
    setAccountAddresses(
        entries: Array<{ credentialId: string; address: `0x${string}`; account?: AccountRecord }>
    ): void {
        if (entries.length === 0) return;
        const byCredential = new Map(entries.map((entry) => [entry.credentialId, entry]));
        const accounts = this.fetchAccounts();
        let changed = false;
        const updated = accounts.map((account) => {
            const entry = byCredential.get(account.credentialId);
            if (!entry) return account;
            const patch: Partial<PasskeyAccount> = {};
            if (!account.address) patch.address = entry.address;
            if (entry.account && !account.account) patch.account = entry.account;
            if (Object.keys(patch).length === 0) return account;
            changed = true;
            return { ...account, ...patch };
        });
        if (changed) this.storage.setItem('accounts', updated);
    }

    /**
     * Fetch the stored record of the account a credential signs for, from the
     * `accounts` endpoint next to the passkey server.
     * @throws If the request fails or the credential is not registered
     */
    async fetchAccountRecord(credentialId: string, dev = false): Promise<AccountRecord> {
        return fetchAccountRecordFromBackend(credentialId, this.apiKey, dev, this.preference.serverUrl);
    }

    /**
     * Create a new WebAuthn passkey
     * @param username - The username for the passkey
     * @param rpId - The relying party identifier (e.g., domain name)
     * @param rpName - The relying party name
     * @returns WebAuthn passkey creation result with credential and challenge
     * @throws {PasskeyRegistrationError} If passkey creation fails
     */
    async createPasskey(
        username: string,
        rpId: string,
        rpName: string,
        createFn?: PasskeyCreateFn,
        nativeCreateFn?: InternalNativeCreateFn,
        getFn?: PasskeyGetFn
    ): Promise<{
        credentialId: string;
        publicKey: `0x${string}`;
        webAuthnAccount: WebAuthnAccount;
        passkeyAccount: PasskeyAccount;
    }> {
        const { credentialId, publicKey, webAuthnAccount } = await createPasskeyUtils(
            username,
            rpId,
            rpName,
            createFn,
            nativeCreateFn,
            getFn
        );
        const passkeyAccount: PasskeyAccount = {
            username,
            credentialId,
            publicKey,
            creationDate: new Date().toISOString(),
            isImported: false,
        };
        this.addAccountToList(passkeyAccount);
        return { credentialId, publicKey, webAuthnAccount, passkeyAccount };
    }

    /**
     * Authenticate with a WebAuthn passkey
     * @param credentialId - The passkey credential ID
     * @param rpId - The relying party identifier (e.g., domain name)
     * @param options - Optional authentication options
     * @returns WebAuthn authentication result with credential and challenge
     * @throws {WebAuthnAuthenticationError} If authentication fails
     */

    async authenticateWithWebAuthn(
        rpId: string,
        credentialId: string,
        options?: {
            userVerification?: UserVerificationRequirement;
            timeout?: number;
            transports?: AuthenticatorTransport[];
        },
        getFn?: PasskeyGetFn
    ): Promise<WebAuthnAuthenticationResult> {
        return authenticateWithWebAuthnUtils(rpId, credentialId, options, getFn);
    }

    /**
     * Import a passkey account from the backend
     * @param getFn - Optional custom WebAuthn get function (React Native adapter)
     * @param rpId - Optional relying party identifier
     * @returns ImportWebAuthnAuthenticationResult
     * @throws {PasskeyLookupError} If backend lookup fails or passkey not found
     */
    async importPasskeyAccount(getFn?: PasskeyGetFn, rpId?: string): Promise<ImportWebAuthnAuthenticationResult> {
        const serverUrl = this.preference.serverUrl;
        return importPasskeyUtils(getFn, rpId, this.apiKey, serverUrl);
    }

    /**
     * Register and store a new passkey account
     * Registers the passkey with the backend, then stores locally
     * @param name - Username or display name
     * @param credentialId - The passkey credential ID
     * @param publicKey - The public key associated with the passkey
     * @param address - Wallet address associated with the passkey
     * @param dev - Whether to use the staging environment (default: false)
     * @param account - The record the account was created from
     * @throws {PasskeyRegistrationError} If backend registration fails
     */
    async storePasskeyAccount(
        name: string,
        credentialId: string,
        publicKey: `0x${string}`,
        address: Address,
        dev = false,
        account?: AccountRecord
    ): Promise<void> {
        this.validateDisplayName(name);
        this.validateCredentialId(credentialId);

        // Register with the passkey server
        const serverUrl = this.preference.serverUrl;
        await registerPasskeyInBackend(
            {
                credentialId,
                publicKey,
                displayName: name.trim(),
            },
            this.apiKey,
            dev,
            serverUrl
        );

        // Store auth state
        this.storeAuthState(address, credentialId);

        // Create account metadata
        const newAccount: PasskeyAccount = {
            username: name.trim(),
            credentialId,
            publicKey,
            address,
            ...(account ? { account } : {}),
            creationDate: new Date().toISOString(),
            isImported: false,
        };

        // Add to accounts list
        this.addAccountToList(newAccount);
    }

    /**
     * Lookup and store a passkey account for login (import existing credential)
     * Looks up the passkey from the backend by credentialId, then stores locally
     * @param credentialId - The passkey credential ID to lookup
     * @param address - Wallet address associated with the passkey
     * @param dev - Whether to use the staging environment (default: false)
     * @param account - The record the account was created from
     * @throws {PasskeyLookupError} If backend lookup fails or passkey not found
     */
    async storePasskeyAccountForLogin(
        credentialId: string,
        address: Address,
        dev = false,
        account?: AccountRecord
    ): Promise<void> {
        // Lookup from the passkey server first
        const serverUrl = this.preference.serverUrl;
        const passkeyData = await lookupPasskeyFromBackend(credentialId, this.apiKey, dev, serverUrl);

        // Store auth state (validates inputs)
        this.storeAuthState(address, credentialId);

        // Create account metadata (marked as imported)
        // Use WebAuthn's credentialId param (not backend's) to prevent encoding mismatches
        const newAccount: PasskeyAccount = {
            username: passkeyData.displayName.trim(),
            credentialId,
            publicKey: passkeyData.publicKey as `0x${string}`,
            address,
            ...(account ? { account } : {}),
            creationDate: new Date().toISOString(),
            isImported: true,
        };

        // Add to accounts list
        this.addAccountToList(newAccount);
    }

    /**
     * Remove a passkey account from the stored list
     * If the removed account is currently active, logout the user
     * @param credentialId - The credential ID to remove
     */
    removeAccount(credentialId: string): void {
        const accounts = this.fetchAccounts();
        const filteredAccounts = accounts.filter((account) => account.credentialId !== credentialId);
        this.storage.setItem('accounts', filteredAccounts);

        // If removing the currently active credential, clear auth state
        const activeCredentialId = this.fetchActiveCredentialId();
        if (activeCredentialId === credentialId) {
            this.logout();
        }
    }

    /**
     * Clear all stored data (accounts, auth state)
     */
    clearAll(): void {
        this.storage.removeItem('authState');
        this.storage.removeItem('accounts');
    }

    /**
     * Get account by credential ID
     */
    getAccountByCredentialId(credentialId: string): PasskeyAccount | undefined {
        const accounts = this.fetchAccounts();
        return accounts.find((account) => account.credentialId === credentialId);
    }

    /**
     * Get the currently active account
     */
    getCurrentAccount(): PasskeyAccount | undefined {
        const credentialId = this.fetchActiveCredentialId();
        if (!credentialId) {
            return undefined;
        }
        return this.getAccountByCredentialId(credentialId);
    }

    /**
     * Check if an account exists
     */
    hasAccount(credentialId: string): boolean {
        return this.getAccountByCredentialId(credentialId) !== undefined;
    }

    /**
     * Get provider preference configuration
     */
    getPreference(): JawProviderPreference {
        return { ...this.preference };
    }

    /**
     * Update provider preference configuration
     */
    updatePreference(preference: Partial<JawProviderPreference>): void {
        this.preference = { ...this.preference, ...preference };
    }

    /**
     * Validate credential ID format
     */
    private validateCredentialId(credentialId: string): void {
        if (!credentialId || !PasskeyManager.CREDENTIAL_ID_REGEX.test(credentialId)) {
            throw new Error(`Invalid credential ID format: ${credentialId}`);
        }
    }

    /**
     * Validate display name
     */
    private validateDisplayName(name: string): void {
        const trimmedName = name.trim();
        if (!trimmedName) {
            throw new Error('Display name cannot be empty');
        }
        if (trimmedName.length > 100) {
            throw new Error('Display name cannot exceed 100 characters');
        }
    }
}
