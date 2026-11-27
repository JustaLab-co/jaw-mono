import { type PasskeyAccount, Account, PasskeyManager, type Chain } from '@jaw.id/core';
import { derivePrfKeys, PrfUnavailableError } from '@jaw.id/core/internal';
import { debugLog } from './debug-log';
import type { Address } from 'viem';

export interface PasskeyCreationResult {
  credentialId: string;
  publicKey: `0x${string}`;
  address: Address;
  account: PasskeyAccount;
}

export interface PasskeyAuthenticationResult {
  credentialId: string;
  address: Address;
  account: PasskeyAccount;
}

/**
 * PasskeyService handles WebAuthn passkey creation and authentication
 * Uses Account class for all passkey operations
 */
export class PasskeyService {
  private rpId: string;
  private rpName: string;
  private apiKey: string;
  private defaultChainId: number;

  constructor(preference?: { serverUrl?: string; apiKey?: string; localOnly?: boolean; defaultChainId?: number }) {
    this.apiKey = preference?.apiKey || '';
    this.defaultChainId = preference?.defaultChainId ?? +(process.env.NEXT_PUBLIC_CHAIN_ID || 1);
    // For local development, use localhost
    // For production, use your actual domain
    this.rpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    this.rpName = 'JAW';
  }

  private getDefaultChainId(): number {
    return this.defaultChainId;
  }

  /**
   * Check if WebAuthn is supported
   */
  isWebAuthnSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.PublicKeyCredential !== undefined &&
      typeof window.PublicKeyCredential === 'function'
    );
  }

  /**
   * Check if user is already authenticated
   */
  checkAuth() {
    const address = Account.getAuthenticatedAddress(this.apiKey);
    return {
      isAuthenticated: address !== null,
      address,
    };
  }

  /**
   * Get all stored passkey accounts
   */
  fetchAccounts(): PasskeyAccount[] {
    return Account.getStoredAccounts(this.apiKey);
  }

  /**
   * Create a new passkey and account
   * @param username - Display name for the passkey
   * @returns Passkey creation result with address and credential details
   */
  async createPasskey(username: string): Promise<PasskeyCreationResult> {
    if (!this.isWebAuthnSupported()) {
      throw new Error('WebAuthn is not supported in this browser');
    }

    try {
      // Create account using Account.create which handles everything
      const account = await Account.create(
        {
          chainId: this.getDefaultChainId(),
          apiKey: this.apiKey,
          rpId: this.rpId,
          rpName: this.rpName,
        },
        {
          username,
        }
      );

      const metadata = account.getMetadata();
      if (!metadata) {
        throw new Error('Failed to get account metadata after creation');
      }

      // Get the passkey account from stored accounts
      const storedAccounts = Account.getStoredAccounts(this.apiKey);
      const passkeyAccount = storedAccounts.find((acc) => acc.username === username);

      if (!passkeyAccount) {
        throw new Error('Failed to retrieve created passkey account');
      }

      debugLog('🔍 Smart account address:', account.address);

      return {
        credentialId: passkeyAccount.credentialId,
        publicKey: passkeyAccount.publicKey,
        address: account.address,
        account: passkeyAccount,
      };
    } catch (error) {
      console.error('Failed to create passkey:', error);
      throw error;
    }
  }

  /**
   * Prompt for the account's passkey and derive one 32-byte key per label from
   * its PRF output. The PRF output itself never leaves @jaw.id/core; callers get
   * only the derived keys, must zero them after use, and must never log, store
   * or send them.
   * @param credentialId - The account's credential; only this passkey may answer
   * @param labels - Versioned labels, `jaw.id/<use>/v<N>`
   *
   * Records the outcome on the stored account (and the passkey server, with the
   * prompt's assertion as proof of holding the passkey): a result means the
   * passkey supports PRF, PrfUnavailableError that it does not.
   * @throws {PrfUnavailableError} If the passkey's store does not support PRF
   */
  async derivePrfKeys<const L extends string>(
    credentialId: string,
    labels: readonly L[]
  ): Promise<Record<L, Uint8Array>> {
    if (!this.isWebAuthnSupported()) {
      throw new Error('WebAuthn is not supported in this browser');
    }
    const manager = new PasskeyManager(undefined, undefined, this.apiKey);
    try {
      const { keys, proof } = await derivePrfKeys({ rpId: this.rpId, credentialId }, labels);
      void manager.recordAuthenticatorInfo(credentialId, { prfSupported: true }, false, proof);
      return keys;
    } catch (error) {
      if (error instanceof PrfUnavailableError) {
        void manager.recordAuthenticatorInfo(credentialId, { prfSupported: false }, false, error.proof);
      }
      throw error;
    }
  }

  /**
   * Authenticate with existing passkey (login)
   * @param credentialId - specific credential ID to authenticate with
   * @returns Authentication result with address and account
   */
  async authenticateWithPasskey(credentialId: string): Promise<PasskeyAuthenticationResult> {
    if (!this.isWebAuthnSupported()) {
      throw new Error('WebAuthn is not supported in this browser');
    }

    try {
      // Get existing passkeys
      const existingAccounts = this.fetchAccounts();

      // If no accounts exist, throw error
      if (existingAccounts.length === 0) {
        throw new Error('No passkeys found. Please create a passkey first.');
      }

      debugLog('🔍 Found accounts:', existingAccounts.length);
      debugLog('🌐 Using rpId:', this.rpId);

      // Find the passkey data
      const passkeyData = existingAccounts.find((acc) => acc.credentialId === credentialId);
      if (!passkeyData) {
        // Do not embed the credentialId in the message — credential
        // identifiers are sensitive (PII) and this surfaces to the UI.
        throw new Error('The requested passkey was not found.');
      }

      // Do not log credentialId — credential identifiers are sensitive (PII).
      debugLog('✅ Using account:', passkeyData.username);

      // Use Account.get which handles WebAuthn authentication
      const account = await Account.get(
        {
          chainId: this.getDefaultChainId(),
          apiKey: this.apiKey,
        },
        credentialId
      );

      return {
        credentialId,
        address: account.address,
        account: passkeyData,
      };
    } catch (error) {
      console.error('Failed to authenticate with passkey:', error);
      throw error;
    }
  }

  /**
   * Import a passkey account from the cloud
   * @returns PasskeyAuthenticationResult
   */
  async importPasskeyAccount(): Promise<PasskeyAuthenticationResult> {
    // Import passkey using Account.import which handles everything
    const account = await Account.import({
      chainId: this.getDefaultChainId(),
      apiKey: this.apiKey,
    });

    const metadata = account.getMetadata();
    if (!metadata) {
      throw new Error('Failed to get account metadata after import');
    }

    // Get the imported passkey account from stored accounts
    const storedAccounts = Account.getStoredAccounts(this.apiKey);
    const passkeyAccount = storedAccounts.find((acc) => acc.isImported && acc.username === metadata.username);

    if (!passkeyAccount) {
      throw new Error('Failed to retrieve imported passkey account');
    }

    return {
      credentialId: passkeyAccount.credentialId,
      address: account.address,
      account: passkeyAccount,
    };
  }

  /**
   * Get an Account instance for signing operations
   * @param chain - Chain configuration
   * @returns Account instance
   */
  async getAccount(chain: Chain): Promise<Account> {
    return Account.get({
      chainId: chain.id,
      apiKey: this.apiKey,
      paymasterUrl: chain.paymaster?.url,
    });
  }
}
