import type { Address, Hash, Hex, TypedDataDefinition, TypedData, LocalAccount } from 'viem';
import { isHex, encodeFunctionData, erc20Abi, createPublicClient, http, numberToHex } from 'viem';
import { toWebAuthnAccount, type SmartAccount } from 'viem/account-abstraction';
import {
    createSmartAccount,
    createSmartAccountForAddress,
    sendTransaction as sendSmartAccountTransaction,
    sendCalls as sendSmartAccountCalls,
    sendCallsWithPermission as sendSmartAccountCallsWithPermission,
    buildPermissionManagerCall,
    estimateUserOpGas,
    estimateUserOpGasWithPermission,
    calculateGas,
    getBundlerClient,
    createSmartAccountEip7702,
    type BundledTransactionResult,
} from './smartAccount.js';
import {
    storeCallStatus,
    waitForReceiptInBackground,
    getCallStatusEIP5792,
    transformReceiptsToEIP5792,
    type CallStatusResponse,
} from '../rpc/wallet_sendCalls.js';
import type { JustanAccountImplementation } from './toJustanAccount.js';
import {
    PasskeyManager,
    type PasskeyAccount,
    type NativePasskeyGetFn,
    type NativePasskeyCreateFn,
    resolvePasskeyOptions,
    resolveRpId,
} from '../passkey-manager/index.js';
import type { SyncStorage } from '../storage-manager/index.js';
import { buildSpenderPrefundCall, type GrantPermissionsOptions } from './spenderPrefund.js';
import {
    grantPermissions as grantSmartAccountPermissions,
    revokePermission as revokeSmartAccountPermission,
    getPermissionFromRelay,
    relayPermissionToPermission,
    buildGrantPermissionCall,
    buildRevokePermissionCall,
    type PermissionsDetail,
    type WalletGrantPermissionsResponse,
    type RevokePermissionApiResponse,
    type CallPermissionDetail,
    type SpendPermissionDetail,
} from '../rpc/permissions.js';
import { JAW_RPC_URL, JAW_PAYMASTER_URL, ERC20_PAYMASTER_ADDRESS } from '../constants.js';
import { type Chain, chains as chainStore } from '../store/index.js';
import { logAccountIssuance } from '../analytics/index.js';

/**
 * Configuration for creating or loading an Account
 */
export interface AccountConfig {
    /** Chain ID for the account */
    chainId: number;
    /** API key for JAW services (required) */
    apiKey: string;
    /** Custom paymaster URL for gas sponsorship */
    paymasterUrl?: string;
    /** Custom paymaster context for gas sponsorship */
    paymasterContext?: Record<string, unknown>;
    /** Custom storage implementation (defaults to localStorage on web, in-memory in RN) */
    storage?: SyncStorage;
    /** Native passkey get function for React Native (e.g. Passkey.get from react-native-passkey) */
    nativeGetFn?: NativePasskeyGetFn;
    /** Native passkey create function for React Native (e.g. Passkey.create from react-native-passkey) */
    nativeCreateFn?: NativePasskeyCreateFn;
    /** Relying party identifier (defaults to window.location.hostname). Required in React Native. */
    rpId?: string;
    /** Relying party name (defaults to 'JAW') */
    rpName?: string;
}

/**
 * Options for creating a new account with passkey
 */
export interface CreateAccountOptions {
    /** Username/display name for the passkey */
    username: string;
}

/**
 * Transaction call structure
 */
export interface TransactionCall {
    /** Target contract address */
    to: Address;
    /** Value to send in wei (bigint or hex string) */
    value?: bigint | string;
    /** Call data */
    data?: Hex;
}

/**
 * Options for sendCalls method
 */
export interface SendCallsOptions {
    /** Permission ID to use for executing the calls through the permission manager */
    permissionId?: Hex;
    /** Override account address — execute on behalf of a different account this passkey owns */
    from?: Address;
}

/**
 * Account metadata returned by getMetadata()
 */
export interface AccountMetadata {
    /** Username/display name for the account */
    username: string;
    /** ISO date string when the account was created */
    creationDate: string;
    /** Whether the account was imported from cloud backup */
    isImported: boolean;
    /** The credential ID of the passkey */
    credentialId: string;
}

/**
 * High-level API for smart account operations
 *
 * The Account class provides a unified interface for:
 * - Creating and managing smart accounts with passkey authentication
 * - Signing messages and typed data
 * - Sending transactions (single and bundled)
 * - Granting and revoking permissions
 *
 * @example
 * ```typescript
 * // Load existing account
 * const account = await Account.load({ chainId: 1, apiKey: 'your-api-key' });
 *
 * // Create new account
 * const account = await Account.create(
 *   { chainId: 1, apiKey: 'your-api-key' },
 *   { username: 'myuser' }
 * );
 *
 * // Send transaction (value in wei)
 * const hash = await account.sendTransaction([
 *   { to: '0x...', value: 100000000000000000n, data: '0x' }
 * ]);
 * ```
 */
export class Account {
    private readonly _smartAccount: SmartAccount;
    private readonly _chain: Chain;
    private readonly _passkeyAccount: PasskeyAccount | null;
    private readonly _apiKey: string;
    private readonly _localAccount: LocalAccount | null;

    /**
     * Private constructor - use static factory methods to create instances
     */
    private constructor(
        smartAccount: SmartAccount,
        chain: Chain,
        apiKey: string,
        passkeyAccount?: PasskeyAccount,
        localAccount?: LocalAccount
    ) {
        this._smartAccount = smartAccount;
        this._chain = chain;
        this._passkeyAccount = passkeyAccount ?? null;
        this._apiKey = apiKey;
        this._localAccount = localAccount ?? null;
    }

    // ============================================
    // Static Factory Methods
    // ============================================

    /**
     * Derive and persist addresses for stored accounts that predate address
     * persistence, returning the (updated) stored list.
     *
     * Ceremony-free: builds a WebAuthn account object from the stored publicKey
     * (nothing is ever signed) and asks the factory for the counterfactual
     * address — the same derivation Account.get performs at login. Failures are
     * per-record and non-fatal; a record left without an address is retried on
     * the next call.
     */
    static async backfillStoredAccountAddresses(config: AccountConfig): Promise<PasskeyAccount[]> {
        const { chainId, apiKey, paymasterUrl } = config;
        const passkeyManager = new PasskeyManager(config.storage, undefined, apiKey);
        const accounts = passkeyManager.fetchAccounts();
        const missing = accounts.filter((account) => !account.address);
        if (missing.length === 0) return accounts;

        const chain = Account.buildChainConfig(chainId, apiKey, paymasterUrl);
        const bundlerClient = getBundlerClient(chain);

        const derived = await Promise.all(
            missing.map(async (account) => {
                try {
                    const webAuthnAccount = toWebAuthnAccount({
                        credential: {
                            id: account.credentialId,
                            publicKey: account.publicKey,
                        },
                    });
                    const smartAccount = await createSmartAccount(
                        webAuthnAccount,
                        bundlerClient as JustanAccountImplementation['client']
                    );
                    account.address = await smartAccount.getAddress();
                    return { credentialId: account.credentialId, address: account.address };
                } catch {
                    /* leave the record without an address; next call retries */
                    return null;
                }
            })
        );

        // One batched write: a setAccountAddress per result would race the reads
        // and drop all but the last address.
        passkeyManager.setAccountAddresses(
            derived.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        );
        return accounts;
    }

    /**
     * Get an account - restores if already authenticated, or triggers login if credentialId provided
     *
     * This is the primary method to get an Account instance:
     * - If already authenticated: restores account from storage (no WebAuthn prompt)
     * - If credentialId provided and not authenticated: triggers WebAuthn login
     * - If not authenticated and no credentialId: throws error
     *
     * @param config - Account configuration
     * @param credentialId - Optional credential ID to login with (triggers WebAuthn if not already authenticated)
     * @returns Promise resolving to the Account instance
     * @throws Error if not authenticated and no credentialId provided
     *
     * @example
     * ```typescript
     * // Restore existing session (no prompt)
     * const account = await Account.get({ chainId: 1, apiKey: 'your-api-key' });
     *
     * // Login with specific credential (triggers WebAuthn if needed)
     * const accounts = Account.getStoredAccounts('your-api-key');
     * const account = await Account.get(
     *   { chainId: 1, apiKey: 'your-api-key' },
     *   accounts[0].credentialId
     * );
     * ```
     */
    static async get(config: AccountConfig, credentialId?: string): Promise<Account> {
        const { chainId, apiKey, paymasterUrl, paymasterContext } = config;

        // Resolve native passkey functions into viem-compatible getFn
        const resolved = resolvePasskeyOptions({
            nativeGetFn: config.nativeGetFn,
        });
        const getFn = resolved.getFn;
        const rpIdOption = config.rpId;

        const passkeyManager = new PasskeyManager(config.storage, undefined, apiKey);
        const authResult = passkeyManager.checkAuth();

        // If credentialId is explicitly provided, always require WebAuthn authentication
        // This ensures user verification when selecting a specific account to login with
        if (credentialId) {
            const passkeyAccount = passkeyManager.getAccountByCredentialId(credentialId);
            if (!passkeyAccount) {
                throw new Error(`No account found for credential ID: ${credentialId}`);
            }

            const rpId = resolveRpId(rpIdOption);

            // Authenticate with WebAuthn
            await passkeyManager.authenticateWithWebAuthn(rpId, credentialId, undefined, getFn);

            const webAuthnAccount = toWebAuthnAccount({
                credential: {
                    id: credentialId,
                    publicKey: passkeyAccount.publicKey,
                },
                getFn,
                rpId,
            });

            const chain = Account.buildChainConfig(chainId, apiKey, paymasterUrl, paymasterContext);
            const bundlerClient = getBundlerClient(chain);
            const smartAccount = await createSmartAccount(
                webAuthnAccount,
                bundlerClient as JustanAccountImplementation['client']
            );
            const address = await smartAccount.getAddress();

            // Store auth state
            passkeyManager.storeAuthState(address, credentialId);

            return new Account(smartAccount, chain, apiKey, passkeyAccount);
        }

        // No credentialId provided - restore from existing auth state if available
        if (authResult.isAuthenticated && authResult.address) {
            const currentAccount = passkeyManager.getCurrentAccount();
            if (currentAccount) {
                const rpId = resolveRpId(rpIdOption);
                const webAuthnAccount = toWebAuthnAccount({
                    credential: {
                        id: currentAccount.credentialId,
                        publicKey: currentAccount.publicKey,
                    },
                    getFn,
                    rpId,
                });

                const chain = Account.buildChainConfig(chainId, apiKey, paymasterUrl, paymasterContext);
                const bundlerClient = getBundlerClient(chain);
                const smartAccount = await createSmartAccount(
                    webAuthnAccount,
                    bundlerClient as JustanAccountImplementation['client']
                );

                return new Account(smartAccount, chain, apiKey, currentAccount);
            }
        }

        // Not authenticated and no credentialId provided
        throw new Error('Not authenticated. Please provide a credentialId to login, or create an account first.');
    }

    /**
     * Restore an Account from existing credential info WITHOUT triggering WebAuthn
     *
     * Use this method when the user has already authenticated (e.g., during connection)
     * and you just need to restore the Account instance for signing operations.
     * The actual signing will trigger its own WebAuthn prompt.
     *
     * @param config - Account configuration
     * @param credentialId - The credential ID of the passkey
     * @param publicKey - The public key of the passkey
     * @returns Promise resolving to the Account instance
     *
     * @example
     * ```typescript
     * // Restore account from session data (no WebAuthn prompt)
     * const account = await Account.restore(
     *   { chainId: 1, apiKey: 'your-api-key' },
     *   session.authState.credentialId,
     *   session.authState.publicKey
     * );
     *
     * // Signing will trigger WebAuthn
     * const signature = await account.signMessage('Hello');
     * ```
     */
    static async restore(config: AccountConfig, credentialId: string, publicKey: `0x${string}`): Promise<Account> {
        const { chainId, apiKey, paymasterUrl, paymasterContext } = config;

        if (!credentialId || !publicKey) {
            throw new Error('credentialId and publicKey are required to restore an account');
        }

        const resolved = resolvePasskeyOptions({
            nativeGetFn: config.nativeGetFn,
        });

        const passkeyManager = new PasskeyManager(config.storage, undefined, apiKey);
        const passkeyAccount = passkeyManager.getAccountByCredentialId(credentialId);

        // validates publicKey against the locally cached entry when present; not a primary defense
        if (passkeyAccount && passkeyAccount.publicKey !== publicKey) {
            throw new Error(
                'Provided publicKey does not match the stored publicKey for this credential. ' +
                    'Use the publicKey from Account.getStoredAccounts() or Account.getCurrentAccount().'
            );
        }

        // Create WebAuthn account from credential info (no WebAuthn prompt)
        const webAuthnAccount = toWebAuthnAccount({
            credential: {
                id: credentialId,
                publicKey: publicKey,
            },
            getFn: resolved.getFn,
            ...(config.rpId ? { rpId: config.rpId } : {}),
        });

        const chain = Account.buildChainConfig(chainId, apiKey, paymasterUrl, paymasterContext);
        const bundlerClient = getBundlerClient(chain);
        const smartAccount = await createSmartAccount(
            webAuthnAccount,
            bundlerClient as JustanAccountImplementation['client']
        );

        // Use passkeyAccount if found, otherwise create minimal metadata
        const accountMetadata = passkeyAccount ?? {
            username: '',
            credentialId,
            publicKey,
            creationDate: new Date().toISOString(),
            isImported: false,
        };

        return new Account(smartAccount, chain, apiKey, accountMetadata);
    }

    /**
     * Create a new account with a passkey
     *
     * @param config - Account configuration
     * @param options - Options for creating the passkey
     * @returns Promise resolving to the new Account instance
     *
     * @example
     * ```typescript
     * const account = await Account.create(
     *   { chainId: 1, apiKey: 'your-api-key' },
     *   { username: 'myuser' }
     * );
     * ```
     */
    static async create(config: AccountConfig, options: CreateAccountOptions): Promise<Account> {
        const { chainId, apiKey, paymasterUrl, paymasterContext } = config;
        const { username } = options;

        const resolved = resolvePasskeyOptions({
            nativeGetFn: config.nativeGetFn,
            nativeCreateFn: config.nativeCreateFn,
        });

        const resolvedRpId = resolveRpId(config.rpId);
        const resolvedRpName = config.rpName ?? 'JAW';

        const passkeyManager = new PasskeyManager(config.storage, undefined, apiKey);

        // Create the passkey
        const { credentialId, publicKey, webAuthnAccount, passkeyAccount } = await passkeyManager.createPasskey(
            username,
            resolvedRpId,
            resolvedRpName,
            undefined, // createFn — browser uses default, native path uses internalNativeCreateFn
            resolved.internalNativeCreateFn,
            resolved.getFn
        );

        const chain = Account.buildChainConfig(chainId, apiKey, paymasterUrl, paymasterContext);

        const bundlerClient = getBundlerClient(chain);
        const smartAccount = await createSmartAccount(
            webAuthnAccount,
            bundlerClient as JustanAccountImplementation['client']
        );
        const address = await smartAccount.getAddress();

        // Store the passkey account with the smart account address
        await passkeyManager.storePasskeyAccount(username, credentialId, publicKey, address);

        // Log account issuance for analytics (fire-and-forget)
        logAccountIssuance({ address, type: 'create', apiKey });

        return new Account(smartAccount, chain, apiKey, passkeyAccount);
    }

    /**
     * Import a passkey from cloud backup
     *
     * @param config - Account configuration
     * @returns Promise resolving to the imported Account instance
     *
     * @example
     * ```typescript
     * const account = await Account.import({ chainId: 1, apiKey: 'your-api-key' });
     * ```
     */
    static async import(config: AccountConfig): Promise<Account> {
        const { chainId, apiKey, paymasterUrl, paymasterContext } = config;

        const resolved = resolvePasskeyOptions({
            nativeGetFn: config.nativeGetFn,
        });

        const passkeyManager = new PasskeyManager(config.storage, undefined, apiKey);

        // Import passkey from cloud backup
        const importResult = await passkeyManager.importPasskeyAccount(resolved.getFn, config.rpId);

        const webAuthnAccount = toWebAuthnAccount({
            credential: {
                id: importResult.credential.id,
                publicKey: importResult.credential.publicKey,
            },
            getFn: resolved.getFn,
            ...(config.rpId ? { rpId: config.rpId } : {}),
        });

        const chain = Account.buildChainConfig(chainId, apiKey, paymasterUrl, paymasterContext);

        const bundlerClient = getBundlerClient(chain);
        const smartAccount = await createSmartAccount(
            webAuthnAccount,
            bundlerClient as JustanAccountImplementation['client']
        );
        const address = await smartAccount.getAddress();

        // Store for login (marks as imported)
        await passkeyManager.storePasskeyAccountForLogin(importResult.credential.id, address);

        const passkeyAccount = passkeyManager.getAccountByCredentialId(importResult.credential.id);
        if (!passkeyAccount) {
            throw new Error('Failed to retrieve imported passkey account.');
        }

        // Log account issuance for analytics (fire-and-forget)
        logAccountIssuance({ address, type: 'import', apiKey });

        return new Account(smartAccount, chain, apiKey, passkeyAccount);
    }

    /**
     * Create an account from a LocalAccount (e.g., from Privy, Dynamic, or private key)
     *
     * This method is ideal for server-side usage or when integrating with
     * embedded wallet providers like Privy, Dynamic, Magic, Turnkey, etc.
     *
     * @param config - Account configuration
     * @param localAccount - A viem LocalAccount instance
     * @param options - Optional settings
     * @param options.eip7702 - If true, the EOA address is preserved as the smart account address
     *                          via EIP-7702 delegation instead of creating a new counterfactual address
     * @returns Promise resolving to the Account instance
     *
     * @example
     * ```typescript
     * import { privateKeyToAccount } from 'viem/accounts';
     *
     * // New counterfactual address
     * const account = await Account.fromLocalAccount(
     *   { chainId: 1, apiKey: 'your-api-key' },
     *   privateKeyToAccount('0x...')
     * );
     *
     * // Keep EOA address via EIP-7702
     * const account = await Account.fromLocalAccount(
     *   { chainId: 1, apiKey: 'your-api-key' },
     *   privateKeyToAccount('0x...'),
     *   { eip7702: true }
     * );
     * // account.address === eoa.address
     * ```
     */
    static async fromLocalAccount(
        config: AccountConfig,
        localAccount: LocalAccount,
        options?: { eip7702?: boolean }
    ): Promise<Account> {
        const { chainId, apiKey, paymasterUrl, paymasterContext } = config;
        const isEip7702 = options?.eip7702 ?? false;

        const chain = Account.buildChainConfig(chainId, apiKey, paymasterUrl, paymasterContext);

        const bundlerClient = getBundlerClient(chain);
        const smartAccount = isEip7702
            ? await createSmartAccountEip7702(localAccount, bundlerClient as JustanAccountImplementation['client'])
            : await createSmartAccount(localAccount, bundlerClient as JustanAccountImplementation['client']);

        const address = await smartAccount.getAddress();

        // Log account issuance for analytics (fire-and-forget)
        logAccountIssuance({ address, type: 'fromLocalAccount', apiKey });

        return new Account(smartAccount, chain, apiKey, undefined, isEip7702 ? localAccount : undefined);
    }

    // ============================================
    // Static Utility Methods
    // ============================================

    /**
     * Get the authenticated account address without fully loading the account
     *
     * Use this to check if authenticated: `Account.getAuthenticatedAddress() !== null`
     *
     * @param apiKey - Optional API key
     * @returns The account address or null if not authenticated
     *
     * @example
     * ```typescript
     * const address = Account.getAuthenticatedAddress('your-api-key');
     * if (address) {
     *   console.log('Current address:', address);
     *   const account = await Account.get({ chainId: 1, apiKey: 'your-api-key' });
     * }
     * ```
     */
    static getAuthenticatedAddress(apiKey?: string, storage?: SyncStorage): Address | null {
        const passkeyManager = new PasskeyManager(storage, undefined, apiKey);
        const authResult = passkeyManager.checkAuth();
        return authResult.isAuthenticated && authResult.address ? (authResult.address as Address) : null;
    }

    /**
     * Get all stored passkey accounts
     *
     * @param apiKey - Optional API key
     * @param storage - Optional custom storage (defaults to localStorage on web, in-memory in RN)
     * @returns Array of stored passkey accounts
     *
     * @example
     * ```typescript
     * const accounts = Account.getStoredAccounts('your-api-key');
     * console.log(`Found ${accounts.length} stored accounts`);
     * ```
     */
    static getStoredAccounts(apiKey?: string, storage?: SyncStorage): PasskeyAccount[] {
        const passkeyManager = new PasskeyManager(storage, undefined, apiKey);
        return passkeyManager.fetchAccounts();
    }

    /**
     * Get the currently authenticated account data
     *
     * @param apiKey - Optional API key
     * @param storage - Optional custom storage (defaults to localStorage on web, in-memory in RN)
     * @returns The current account data if authenticated, null otherwise
     *
     * @example
     * ```typescript
     * const account = Account.getCurrentAccount('your-api-key');
     * if (account) {
     *   console.log(`Authenticated as: ${account.username}`);
     * }
     * ```
     */
    static getCurrentAccount(apiKey?: string, storage?: SyncStorage): PasskeyAccount | null {
        const passkeyManager = new PasskeyManager(storage, undefined, apiKey);
        return passkeyManager.getCurrentAccount() || null;
    }

    /**
     * Clear authentication state (logout)
     *
     * @param apiKey - Optional API key
     * @param storage - Optional custom storage (defaults to localStorage on web, in-memory in RN)
     *
     * @example
     * ```typescript
     * Account.logout('your-api-key');
     * ```
     */
    static logout(apiKey?: string, storage?: SyncStorage): void {
        const passkeyManager = new PasskeyManager(storage, undefined, apiKey);
        passkeyManager.logout();
    }

    // ============================================
    // Instance Properties
    // ============================================

    /**
     * The smart account address
     */
    get address(): Address {
        return this._smartAccount.address;
    }

    /**
     * The current chain ID
     */
    get chainId(): number {
        return this._chain.id;
    }

    // ============================================
    // Instance Methods - Info
    // ============================================

    /**
     * Get account metadata (only available for passkey-based accounts)
     *
     * @returns Account metadata including username, creation date, and import status,
     *          or null for accounts created via fromLocalAccount
     *
     * @example
     * ```typescript
     * const metadata = account.getMetadata();
     * if (metadata) {
     *   console.log(`Username: ${metadata.username}`);
     *   console.log(`Created: ${metadata.creationDate}`);
     * } else {
     *   console.log('Local account - no passkey metadata');
     * }
     * ```
     */
    getMetadata(): AccountMetadata | null {
        if (!this._passkeyAccount) {
            return null;
        }
        return {
            username: this._passkeyAccount.username,
            creationDate: this._passkeyAccount.creationDate,
            isImported: this._passkeyAccount.isImported,
            credentialId: this._passkeyAccount.credentialId,
        };
    }

    /**
     * Get the underlying viem SmartAccount for advanced operations
     *
     * @returns The raw SmartAccount instance
     *
     * @example
     * ```typescript
     * const smartAccount = account.getSmartAccount();
     * // Use for advanced viem operations
     * ```
     */
    getSmartAccount(): SmartAccount {
        return this._smartAccount;
    }

    /**
     * Get the SmartAccount for a given address, resolving an override if needed.
     * If the address matches the connected account (or is omitted), returns the default SmartAccount.
     * Otherwise, creates a temporary SmartAccount for the target address using the current signer.
     */
    async getSmartAccountFor(address?: Address): Promise<SmartAccount> {
        return this.resolveSmartAccount(address);
    }

    /**
     * Get the chain configuration
     *
     * @returns The Chain configuration object
     *
     * @example
     * ```typescript
     * const chain = account.getChain();
     * console.log(`Paymaster: ${chain.paymaster?.url}`);
     * ```
     */
    getChain(): Chain {
        return { ...this._chain };
    }

    /**
     * Get the smart account address (async)
     *
     * This is useful for getting the counterfactual address before the account is deployed.
     * For deployed accounts, this returns the same value as the `address` property.
     *
     * @returns Promise resolving to the account address
     *
     * @example
     * ```typescript
     * const address = await account.getAddress();
     * console.log('Address:', address);
     * ```
     */
    async getAddress(): Promise<Address> {
        return await this._smartAccount.getAddress();
    }

    // ============================================
    // Instance Methods - Signing
    // ============================================

    /**
     * Sign a personal message
     *
     * @param message - The message to sign
     * @returns Promise resolving to the signature
     *
     * @example
     * ```typescript
     * const signature = await account.signMessage('Hello, World!');
     * ```
     */
    async signMessage(message: string, options?: { address?: Address }): Promise<Hex> {
        const smartAccount = await this.resolveSmartAccount(options?.address);
        return await smartAccount.signMessage({ message });
    }

    /**
     * Sign EIP-712 typed data
     *
     * @param typedData - The typed data to sign
     * @returns Promise resolving to the signature
     *
     * @example
     * ```typescript
     * const signature = await account.signTypedData({
     *   domain: { name: 'MyApp', version: '1' },
     *   types: { Message: [{ name: 'content', type: 'string' }] },
     *   primaryType: 'Message',
     *   message: { content: 'Hello' }
     * });
     * ```
     */
    async signTypedData(
        typedData: TypedDataDefinition<TypedData, string>,
        options?: { address?: Address }
    ): Promise<Hex> {
        const smartAccount = await this.resolveSmartAccount(options?.address);
        return await smartAccount.signTypedData(typedData);
    }

    // ============================================
    // Instance Methods - Transactions
    // ============================================

    /**
     * Send a transaction and wait for the receipt
     *
     * @param calls - Array of transaction calls
     * @returns Promise resolving to the transaction hash
     *
     * @example
     * ```typescript
     * import { parseEther } from 'viem';
     *
     * const hash = await account.sendTransaction([
     *   { to: '0x...', value: parseEther('0.1') },  // Send 0.1 ETH
     *   { to: '0x...', data: '0x...' }              // Contract call
     * ]);
     * ```
     */
    async sendTransaction(
        calls: TransactionCall[],
        paymasterUrlOverride?: string,
        paymasterContextOverride?: Record<string, unknown>,
        from?: Address
    ): Promise<Hash> {
        const smartAccount = await this.resolveSmartAccount(from);
        const isOverride = this.isAddressOverride(from);

        const formattedCalls = calls.map((call) => ({
            to: call.to,
            value: Account.parseValue(call.value),
            data: call.data,
        }));

        // If using JAW ERC-20 paymaster, prepend approval call if needed
        const paymaster = this.resolveEffectivePaymaster(paymasterUrlOverride, paymasterContextOverride);
        const localAccount = isOverride ? undefined : (this._localAccount ?? undefined);
        const approvalCall = await this.createErc20ApprovalCall(
            paymaster.url,
            paymaster.context,
            formattedCalls,
            smartAccount,
            localAccount
        );
        const finalCalls = approvalCall ? [approvalCall, ...formattedCalls] : formattedCalls;

        return await sendSmartAccountTransaction(
            smartAccount,
            finalCalls,
            this._chain,
            paymaster.url,
            paymaster.context,
            this._apiKey,
            localAccount
        );
    }

    /**
     * Send multiple calls as a bundled user operation without waiting for receipt
     *
     * @param calls - Array of transaction calls
     * @param options - Optional settings including permissionId for permission-based execution
     * @returns Promise resolving to the user operation ID and chain ID
     *
     * @example
     * ```typescript
     * import { parseEther } from 'viem';
     *
     * // Standard execution
     * const { id, chainId } = await account.sendCalls([
     *   { to: '0x...', value: parseEther('0.1') }
     * ]);
     * console.log('UserOp hash:', id);
     *
     * // Execution with permission (delegated execution)
     * const { id, chainId } = await account.sendCalls(
     *   [{ to: '0x...', value: parseEther('0.1') }],
     *   { permissionId: '0x...' }
     * );
     *
     * // Check status later
     * const status = await account.getCallStatus(id);
     * ```
     */
    async sendCalls(
        calls: TransactionCall[],
        options?: SendCallsOptions,
        paymasterUrlOverride?: string,
        paymasterContextOverride?: Record<string, unknown>
    ): Promise<BundledTransactionResult> {
        const smartAccount = await this.resolveSmartAccount(options?.from);
        const isOverride = this.isAddressOverride(options?.from);

        const formattedCalls = calls.map((call) => ({
            to: call.to,
            value: Account.parseValue(call.value),
            data: call.data,
        }));

        const paymaster = this.resolveEffectivePaymaster(paymasterUrlOverride, paymasterContextOverride);

        // Don't pass localAccount when overriding address — target is a standard smart account, not EIP-7702
        const localAccount = isOverride ? undefined : (this._localAccount ?? undefined);

        let result: BundledTransactionResult;

        if (options?.permissionId) {
            // Execute through permission manager.
            //
            // The permission-manager call is built here rather than downstream so
            // the ERC-20 approval can be sized over it. What goes out is the
            // wrapper, not the raw calls, and its signature verification and spend
            // accounting cost gas the raw calls do not — sizing over the raw calls
            // approves a ceiling under what the paymaster then charges. It is
            // handed down so the permission is still fetched once and the sized
            // userOp is the sent one.
            const permission = relayPermissionToPermission(
                await getPermissionFromRelay(options.permissionId, this._apiKey)
            );
            const permissionCall = buildPermissionManagerCall(permission, formattedCalls);

            // The approval call must be placed at the spender level (alongside the
            // permission manager call), not inside the permission batch — the
            // permission manager validates each call's selector and would reject
            // the approve selector.
            const approvalCall = await this.createErc20ApprovalCall(
                paymaster.url,
                paymaster.context,
                [permissionCall],
                smartAccount,
                localAccount
            );

            result = await sendSmartAccountCallsWithPermission(
                smartAccount,
                formattedCalls,
                this._chain,
                options.permissionId,
                this._apiKey,
                paymaster.url,
                paymaster.context,
                localAccount,
                approvalCall ?? undefined,
                permissionCall
            );
        } else {
            // Standard execution (EIP-7702 handled inside sendSmartAccountCalls)
            const approvalCall = await this.createErc20ApprovalCall(
                paymaster.url,
                paymaster.context,
                formattedCalls,
                smartAccount,
                localAccount
            );
            const finalCalls = approvalCall ? [approvalCall, ...formattedCalls] : formattedCalls;
            result = await sendSmartAccountCalls(
                smartAccount,
                finalCalls,
                this._chain,
                paymaster.url,
                paymaster.context,
                localAccount
            );
        }

        // Store call status as pending and start background receipt waiting
        storeCallStatus(result.id, result.chainId, this._apiKey);
        waitForReceiptInBackground(result.id, result.chainId, this._apiKey);

        return result;
    }

    /**
     * Get the status of a previously submitted call batch
     *
     * Resolves the in-memory store first (populated by `sendCalls` in the same
     * process). On a miss — typical for short-lived processes like the CLI, or
     * for browsers after a page reload — falls back to querying the bundler
     * directly via `eth_getUserOperationReceipt` so the chain stays the source
     * of truth.
     *
     * @param batchId - The batch ID (userOpHash) returned from sendCalls
     * @returns The call status in EIP-5792 format, or undefined if neither the
     *          in-memory store nor the bundler knows the batch.
     *
     * @example
     * ```typescript
     * const { id } = await account.sendCalls([{ to: '0x...', value: '0.1' }]);
     *
     * // Check status
     * const status = await account.getCallStatus(id);
     * if (status) {
     *   console.log('Status code:', status.status); // 100=pending, 200=completed, 400=failed, 500=reverted
     *   if (status.receipts) {
     *     console.log('Transaction hash:', status.receipts[0].transactionHash);
     *   }
     * }
     * ```
     */
    async getCallStatus(batchId: Hash): Promise<CallStatusResponse | undefined> {
        const cached = getCallStatusEIP5792(batchId);
        if (cached) {
            return cached;
        }

        let receipt;
        try {
            const bundlerClient = getBundlerClient(this._chain);
            receipt = await bundlerClient.getUserOperationReceipt({ hash: batchId });
        } catch {
            return undefined;
        }

        if (!receipt) {
            return undefined;
        }

        const success = receipt.success === true;
        return {
            version: '2.0.0',
            id: batchId,
            chainId: numberToHex(this._chain.id) as `0x${string}`,
            status: success ? 200 : 500,
            atomic: true,
            receipts: transformReceiptsToEIP5792([receipt]),
        };
    }

    /**
     * Estimate gas for a transaction
     *
     * @param calls - Array of transaction calls
     * @param options - Optional settings including permissionId for permission-based execution
     * @returns Promise resolving to the estimated gas amount
     *
     * @example
     * ```typescript
     * import { parseEther } from 'viem';
     *
     * const gas = await account.estimateGas([
     *   { to: '0x...', value: parseEther('0.1') }
     * ]);
     * console.log('Estimated gas:', gas.toString());
     * ```
     */
    async estimateGas(calls: TransactionCall[], options?: { permissionId?: Hex; address?: Address }): Promise<bigint> {
        const smartAccount = await this.resolveSmartAccount(options?.address);

        const formattedCalls = calls.map((call) => ({
            to: call.to,
            value: Account.parseValue(call.value),
            data: call.data,
        }));

        if (options?.permissionId) {
            // Estimate gas for permission-based execution through the permission manager
            return await estimateUserOpGasWithPermission(
                smartAccount,
                formattedCalls,
                this._chain,
                options.permissionId,
                this._apiKey
            );
        }

        return await estimateUserOpGas(smartAccount, formattedCalls, this._chain);
    }

    /**
     * Calculate gas cost in ETH
     *
     * @param calls - Array of transaction calls
     * @param options - Optional settings including permissionId for permission-based execution
     * @returns Promise resolving to the gas cost in ETH as a string
     *
     * @example
     * ```typescript
     * import { parseEther } from 'viem';
     *
     * const cost = await account.calculateGasCost([
     *   { to: '0x...', value: parseEther('0.1') }
     * ]);
     * console.log('Gas cost:', cost, 'ETH');
     * ```
     */
    async calculateGasCost(
        calls: TransactionCall[],
        options?: { permissionId?: Hex; address?: Address }
    ): Promise<string> {
        const gas = await this.estimateGas(calls, options);
        return await calculateGas(this._chain, gas);
    }

    // ============================================
    // Instance Methods - Permissions
    // ============================================

    /**
     * Grant permissions to a spender
     *
     * @param expiry - Timestamp when the permission expires (unix seconds)
     * @param spender - Address that can use the permission
     * @param permissions - Permissions to grant (calls and/or spends)
     * @param paymasterUrlOverride - Optional paymaster URL for ERC-20 payment
     * @param paymasterContextOverride - Optional paymaster context (e.g., token address for ERC-20 payment)
     * @returns Promise resolving to the grant permissions response
     *
     * @example
     * ```typescript
     * const response = await account.grantPermissions(
     *   Math.floor(Date.now() / 1000) + 3600, // 1 hour
     *   '0xSpenderAddress...',
     *   {
     *     calls: [{ target: '0x...', selector: '0xa9059cbb' }],
     *     spends: [{ token: '0xEee...', limit: '1000000000000000000', period: 'day' }]
     *   }
     * );
     * console.log('Permission ID:', response.permissionId);
     * ```
     */
    async grantPermissions(
        expiry: number,
        spender: Address,
        permissions: PermissionsDetail,
        paymasterUrlOverride?: string,
        paymasterContextOverride?: Record<string, unknown>,
        address?: Address,
        options?: GrantPermissionsOptions
    ): Promise<WalletGrantPermissionsResponse> {
        const smartAccount = await this.resolveSmartAccount(address);

        // Build the permission call for gas estimation
        const permissionCall = buildGrantPermissionCall(smartAccount.address, spender, expiry, permissions);

        const paymaster = this.resolveEffectivePaymaster(paymasterUrlOverride, paymasterContextOverride);

        // Ahead of the approval sizing, so the ceiling covers the transfer too.
        const prefundCall = options?.prefundSpender
            ? await this.buildPrefundCall(smartAccount.address, spender, permissions, paymaster.context)
            : null;

        const calls = prefundCall ? [prefundCall, permissionCall] : [permissionCall];

        // Check if we need an ERC-20 approval for the paymaster.
        //
        // A `gas` in the context is a ceiling the caller sized, and the caller
        // sized it off a batch that could not have had the prefund transfer in
        // it: the wallet estimates the grant, and the transfer is added here.
        // So when one was added, ask for the ceiling to be measured again with
        // the batch that will actually be sent. The caller's figure stays as
        // the fallback, because losing the grant to a sizing that could not run
        // is worse than an approval that is a transfer short.
        const resized = prefundCall && paymaster.context?.gas !== undefined;
        const sizingContext = resized
            ? Object.fromEntries(Object.entries(paymaster.context ?? {}).filter(([key]) => key !== 'gas'))
            : paymaster.context;
        let approvalCall: { to: Address; value?: bigint; data: Hex } | null;
        try {
            approvalCall = await this.createErc20ApprovalCall(paymaster.url, sizingContext, calls, smartAccount);
        } catch (error) {
            if (!resized) throw error;
            approvalCall = await this.createErc20ApprovalCall(paymaster.url, paymaster.context, calls, smartAccount);
        }

        return await grantSmartAccountPermissions(
            smartAccount,
            expiry,
            spender,
            permissions,
            this._chain,
            this._apiKey,
            paymaster.url,
            paymaster.context,
            [approvalCall, prefundCall].filter((call) => call !== null)
        );
    }

    /**
     * The transfer that leaves the spender able to pay for its own first userOp,
     * or null when it is not needed. See `spenderPrefund.ts` for the rules.
     */
    private async buildPrefundCall(
        account: Address,
        spender: Address,
        permissions: PermissionsDetail,
        paymasterContext?: Record<string, unknown>
    ): Promise<{ to: Address; value: bigint; data: Hex } | null> {
        const publicClient = createPublicClient({
            chain: { id: this._chain.id } as Parameters<typeof createPublicClient>[0]['chain'],
            transport: http(this._chain.rpcUrl),
        });

        const read = {
            balanceOf: (token: Address, owner: Address) =>
                publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
            gasPrice: () => publicClient.getGasPrice(),
            exchangeRate: async (token: Address) => {
                // JAW's own paymaster, never the one on the request. The rate
                // decides how much leaves the account, to a spender the requester
                // chose, so an inflated rate trims the transfer to the whole
                // allowance and lands it outside the permission. `chain.paymaster`
                // is the requester's too: it rides in on the request from the
                // dapp's own `paymasters` config, and keys builds the account
                // from it.
                const url = `${JAW_PAYMASTER_URL}?chainId=${this._chain.id}${
                    this._apiKey ? `&api-key=${this._apiKey}` : ''
                }`;
                try {
                    const { fetchTokenQuotes } = await import('./erc20Paymaster.js');
                    const quotes = await fetchTokenQuotes(url, this._chain.id, [token]);
                    const rate = quotes[0]?.exchangeRate;
                    // A paymaster that answers but does not take this token. Said
                    // out loud for the same reason as the throw below: otherwise
                    // it is a grant that landed and a session that cannot pay,
                    // with nothing connecting the two.
                    if (rate === undefined) {
                        console.warn(`The paymaster does not quote ${token}, so the spender was not funded.`);
                        return null;
                    }
                    return rate;
                } catch (error) {
                    // The grant is what the user came to do; a paymaster that
                    // will not quote is not a reason to fail it. It is a reason
                    // to say so, though: what the caller sees otherwise is a
                    // grant that landed and a session that cannot pay for its
                    // first operation, with nothing connecting the two.
                    console.warn('Could not price the spender prefund, granting without it:', error);
                    return null;
                }
            },
        };

        return await buildSpenderPrefundCall({
            account,
            spender,
            permissions,
            paymasterContext,
            read,
        });
    }

    /**
     * Revoke a previously granted permission
     *
     * @param permissionId - The permission ID (hash) to revoke
     * @param paymasterUrlOverride - Optional paymaster URL for ERC-20 payment
     * @param paymasterContextOverride - Optional paymaster context (e.g., token address for ERC-20 payment)
     * @returns Promise resolving to the revoke response
     *
     * @example
     * ```typescript
     * const response = await account.revokePermission('0x...');
     * console.log('Revoked:', response.success);
     * ```
     */
    async revokePermission(
        permissionId: Hex,
        paymasterUrlOverride?: string,
        paymasterContextOverride?: Record<string, unknown>,
        address?: Address
    ): Promise<RevokePermissionApiResponse> {
        const smartAccount = await this.resolveSmartAccount(address);

        const paymaster = this.resolveEffectivePaymaster(paymasterUrlOverride, paymasterContextOverride);

        // Build the revoke call for gas estimation (requires fetching permission from relay)
        let revokeCalls: Array<{ to: Address; data: Hex }> = [];
        try {
            const relayPermission = await getPermissionFromRelay(permissionId, this._apiKey);
            const revokeCall = buildRevokePermissionCall(relayPermission);
            revokeCalls = [revokeCall];
        } catch (error) {
            // With no call there is nothing to size the approval over, and an
            // empty list walks past the estimation instead of failing it. Under
            // the ERC-20 paymaster that means the revoke reaches it with no
            // allowance behind it, which it cannot settle. Anywhere else the
            // estimation is one the send can do without.
            if (Account.isJawErc20Paymaster(paymaster.url)) {
                throw new Error(
                    `Could not fetch permission ${permissionId} to size the ERC-20 paymaster approval: ` +
                        `${error instanceof Error ? error.message : String(error)}. ` +
                        'Retry, or revoke without the ERC-20 paymaster.',
                    { cause: error }
                );
            }
            console.warn('Could not fetch permission for gas estimation:', error);
        }

        // Check if we need an ERC-20 approval for the paymaster
        const approvalCall = await this.createErc20ApprovalCall(
            paymaster.url,
            paymaster.context,
            revokeCalls,
            smartAccount
        );

        return await revokeSmartAccountPermission(
            smartAccount,
            permissionId,
            this._chain,
            this._apiKey,
            paymaster.url,
            paymaster.context,
            approvalCall || undefined
        );
    }

    /**
     * Get details of a previously granted permission from the relay
     *
     * @param permissionId - The permission ID (hash) to fetch
     * @returns Promise resolving to the permission details in the same format as grantPermissions response
     *
     * @example
     * ```typescript
     * const details = await account.getPermission('0x...');
     * console.log('Spender:', details.spender);
     * console.log('Expires:', new Date(details.end * 1000));
     * console.log('Calls:', details.calls);
     * console.log('Spends:', details.spends);
     * ```
     */
    async getPermission(permissionId: Hex): Promise<WalletGrantPermissionsResponse> {
        const relayResponse = await getPermissionFromRelay(permissionId, this._apiKey);

        // Transform relay response to WalletGrantPermissionsResponse format
        const calls: CallPermissionDetail[] = relayResponse.calls.map((call) => ({
            target: call.target as Address,
            selector: call.selector as Hex,
        }));

        const spends: SpendPermissionDetail[] = relayResponse.spends.map((spend) => ({
            token: spend.token as Address,
            allowance: spend.allowance,
            unit: spend.unit,
            multiplier: spend.multiplier,
        }));

        return {
            account: relayResponse.account as Address,
            spender: relayResponse.spender as Address,
            start: relayResponse.start,
            end: relayResponse.end,
            salt: relayResponse.salt as Hex,
            calls,
            spends,
            permissionId: relayResponse.permissionId as Hex,
            chainId: relayResponse.chainId as Hex,
        };
    }

    // ============================================
    // Private Instance Helpers
    // ============================================

    /**
     * Resolves which SmartAccount to use for an operation.
     * If overrideAddress is provided and differs from the default, creates a temporary
     * SmartAccount for the target address using the current signer.
     * @internal
     */
    private async resolveSmartAccount(overrideAddress?: Address): Promise<SmartAccount> {
        if (!overrideAddress || overrideAddress.toLowerCase() === this._smartAccount.address.toLowerCase()) {
            return this._smartAccount;
        }

        const bundlerClient = getBundlerClient(this._chain);

        if (this._passkeyAccount) {
            const webAuthnAccount = toWebAuthnAccount({
                credential: {
                    id: this._passkeyAccount.credentialId,
                    publicKey: this._passkeyAccount.publicKey,
                },
            });

            return await createSmartAccountForAddress(
                overrideAddress,
                webAuthnAccount,
                bundlerClient as JustanAccountImplementation['client']
            );
        }

        if (this._localAccount) {
            return await createSmartAccountForAddress(
                overrideAddress,
                this._localAccount,
                bundlerClient as JustanAccountImplementation['client']
            );
        }

        throw new Error('Address override requires a passkey or local account signer');
    }

    /**
     * Returns true if the given address is a valid override (different from the default account).
     * @internal
     */
    private isAddressOverride(address?: Address): boolean {
        return !!address && address.toLowerCase() !== this._smartAccount.address.toLowerCase();
    }

    // ============================================
    // Private Static Helpers
    // ============================================

    /**
     * Build chain configuration with RPC URL and register it in the global
     * chain store. Registration is required so background ops (e.g. receipt
     * polling in waitForReceiptInBackground) can resolve a bundler client by
     * chainId without needing the original Account instance.
     * @internal
     */
    private static buildChainConfig(
        chainId: number,
        apiKey?: string,
        paymasterUrl?: string,
        paymasterContext?: Record<string, unknown>
    ): Chain {
        const rpcUrl = apiKey
            ? `${JAW_RPC_URL}?chainId=${chainId}&api-key=${apiKey}`
            : `${JAW_RPC_URL}?chainId=${chainId}`;

        const chain: Chain = {
            id: chainId,
            rpcUrl,
            // The context has to ride on the chain alongside the url, the same
            // way `createInitialChains` carries a whole `PaymasterConfig`.
            // Keeping only the url is what stranded `AccountConfig.paymasterContext`:
            // the field was accepted, documented and then silently dropped, so an
            // ERC-20 paymaster was handed a userOp naming no token.
            ...(paymasterUrl && {
                paymaster: { url: paymasterUrl, ...(paymasterContext && { context: paymasterContext }) },
            }),
        };

        const existingChains = chainStore.get() ?? [];
        if (!existingChains.some((c) => c.id === chain.id)) {
            chainStore.set([...existingChains, chain]);
        }

        return chain;
    }

    /**
     * Parse value from bigint or hex string to bigint (wei)
     * @internal
     */
    private static parseValue(value: bigint | string | undefined): bigint | undefined {
        if (value === undefined) {
            return undefined;
        }

        if (typeof value === 'bigint') {
            return value;
        }

        // Hex string for wei (e.g., "0x0de0b6b3a7640000")
        if (isHex(value)) {
            return BigInt(value);
        }

        throw new Error(`Invalid value format: ${value}. Use bigint or hex string (wei).`);
    }

    /**
     * Check if the paymaster URL is the JAW ERC-20 paymaster
     * @internal
     */
    private static isJawErc20Paymaster(paymasterUrl?: string): boolean {
        if (!paymasterUrl) return false;
        // Remove query params and compare base URL
        const baseUrl = paymasterUrl.split('?')[0];
        return baseUrl === JAW_PAYMASTER_URL;
    }

    /**
     * Resolve the paymaster a userOp will actually be sent to: an explicit
     * override first, then the chain config this Account was built with.
     *
     * Mirrors `getBundlerClient`'s own precedence, because the two must never
     * disagree. They did: the approval decision read only the override while the
     * userOp's paymaster was resolved from the chain, so a caller that configured
     * the ERC-20 paymaster through `AccountConfig` got a userOp sent to it with
     * no token in context and no approval behind it — which the paymaster cannot
     * settle, since it has no allowance to draw its fee from.
     *
     * The url decides for the pair, rather than each falling back on its own. A
     * caller passing only a url override, on an account configured with a
     * `paymasterContext`, would otherwise send that context to the other
     * paymaster; a context belongs to the paymaster it was written for. The same
     * pairing is applied in `getBundlerClient`, since leaving it here alone would
     * let a `context: undefined` passed downstream fall back to the chain again.
     *
     * `gas` is deliberately left on the returned context: it sizes the approval.
     * `createPaymasterFunctions` strips it before anything goes on the wire.
     * @internal
     */
    private resolveEffectivePaymaster(
        paymasterUrlOverride?: string,
        paymasterContextOverride?: Record<string, unknown>
    ): { url?: string; context?: Record<string, unknown> } {
        const fromOverride = paymasterUrlOverride !== undefined;
        const url = fromOverride ? paymasterUrlOverride : this._chain.paymaster?.url;
        const context = fromOverride ? paymasterContextOverride : this._chain.paymaster?.context;
        return {
            url,
            // An empty context is the same as none; normalising here keeps the
            // downstream `context && …` spreads from emitting an empty object.
            context: context && Object.keys(context).length > 0 ? context : undefined,
        };
    }

    /**
     * Create ERC-20 approval call for the paymaster if using JAW ERC-20 paymaster,
     * only if the current allowance is insufficient.
     * @internal
     */
    private async createErc20ApprovalCall(
        paymasterUrl?: string,
        paymasterContext?: Record<string, unknown>,
        calls?: Array<{ to: Address; value?: bigint; data?: Hex }>,
        smartAccount?: SmartAccount,
        localAccount?: LocalAccount
    ): Promise<{ to: Address; value?: bigint; data: Hex } | null> {
        const account = smartAccount ?? this._smartAccount;
        // Only add approval if using JAW ERC-20 paymaster
        if (!Account.isJawErc20Paymaster(paymasterUrl)) {
            return null;
        }

        // Extract token address and gas amount from context
        const tokenAddress = paymasterContext?.token as string | undefined;
        let gasAmount = paymasterContext?.gas as string | bigint | undefined;
        // Who the allowance is for. The quote names it; the constant is the
        // fallback for the path where `gas` came in the context and no quote is
        // fetched. Approving one address and being charged by another leaves the
        // paymaster unable to settle just the same.
        let spender = ERC20_PAYMASTER_ADDRESS as Address;

        if (!tokenAddress) {
            return null;
        }

        // If gasAmount is undefined, estimate it using the paymaster
        if (gasAmount === undefined && paymasterUrl && calls && calls.length > 0) {
            try {
                const { fetchTokenQuotes, calculateTokenCostFromGas } = await import('./erc20Paymaster.js');
                const { getBundlerClient, prepareCallsForExecution } = await import('./smartAccount.js');

                // Get token quote for exchange rate
                const quotes = await fetchTokenQuotes(paymasterUrl, this._chain.id, [tokenAddress as Address]);

                if (quotes.length === 0) {
                    // No quote is no size. Carrying on would put the userOp in
                    // front of the paymaster with no allowance behind it, which
                    // is the same failure a thrown estimate produces.
                    throw new Error('the paymaster returned no quote for it');
                }

                // Get paymaster address from quote
                const paymasterAddress = quotes[0].paymasterAddress;
                spender = paymasterAddress;

                // Create a dummy approval call for estimation
                // Use MaxUint256 for approval - amount doesn't affect gas estimation
                const MaxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
                const dummyApprovalCall = {
                    to: tokenAddress as Address,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: erc20Abi,
                        functionName: 'approve',
                        args: [paymasterAddress, MaxUint256],
                    }),
                };

                // Include dummy approval in estimation to get accurate gas limits,
                // and let the send's own preparation add what it would add: on a
                // 7702 account not yet owning the permission manager that is an
                // extra owner-setup call, whose gas the ceiling has to cover too.
                const { calls: callsWithApproval, authorization } = await prepareCallsForExecution(
                    account,
                    [dummyApprovalCall, ...calls],
                    this._chain,
                    localAccount
                );

                // Prepare a UserOp to get gas estimates
                const bundlerClient = getBundlerClient(this._chain, paymasterUrl, { token: tokenAddress });

                const userOp = await bundlerClient.prepareUserOperation({
                    account,
                    calls: callsWithApproval,
                    ...(authorization ? { authorization } : {}),
                });

                // Extract gas fields
                const gas = {
                    preVerificationGas: userOp.preVerificationGas,
                    verificationGasLimit: userOp.verificationGasLimit,
                    callGasLimit: userOp.callGasLimit,
                    paymasterVerificationGasLimit:
                        'paymasterVerificationGasLimit' in userOp
                            ? (userOp as { paymasterVerificationGasLimit?: bigint }).paymasterVerificationGasLimit
                            : undefined,
                    paymasterPostOpGasLimit:
                        'paymasterPostOpGasLimit' in userOp
                            ? (userOp as { paymasterPostOpGasLimit?: bigint }).paymasterPostOpGasLimit
                            : undefined,
                    maxFeePerGas: userOp.maxFeePerGas,
                    maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
                };

                // Calculate token cost
                const tokenCost = calculateTokenCostFromGas(gas, quotes[0]);
                gasAmount = tokenCost;
            } catch (error) {
                // Returning null here would leave the userOp on its way to the
                // ERC-20 paymaster with no approval behind it — the exact failure
                // this path exists to prevent, and one that resurfaces as a
                // generic on-chain refusal naming none of this. Only the JAW
                // ERC-20 paymaster reaches here, and it cannot settle without an
                // allowance, so there is no send worth attempting.
                throw new Error(
                    `Could not size the ERC-20 paymaster approval for token ${tokenAddress} on chain ${this._chain.id}: ` +
                        `${error instanceof Error ? error.message : String(error)}. ` +
                        'Pass `gas` in the paymaster context to size the approval yourself, ' +
                        'or send without the ERC-20 paymaster.',
                    { cause: error }
                );
            }
        }

        if (gasAmount === undefined) {
            // If we still don't have gasAmount after estimation attempt, skip approval
            return null;
        }

        // Parse the gas amount from context
        const requiredAmount = typeof gasAmount === 'string' ? BigInt(gasAmount) : gasAmount;

        // Check current allowance
        const publicClient = createPublicClient({
            chain: { id: this._chain.id } as Parameters<typeof createPublicClient>[0]['chain'],
            transport: http(this._chain.rpcUrl),
        });

        const currentAllowance = await publicClient.readContract({
            address: tokenAddress as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account.address, spender],
        });

        // If current allowance is sufficient, no approval needed
        if (currentAllowance >= requiredAmount) {
            return null;
        }
        // Encode ERC-20 approve call for the required amount
        const approveData = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender, requiredAmount],
        });

        return {
            to: tokenAddress as Address,
            value: 0n,
            data: approveData,
        };
    }
}

// Re-export for convenience
export { type BundledTransactionResult } from './smartAccount.js';
