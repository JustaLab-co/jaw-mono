import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account, type Chain, type PasskeyAccount } from '@jaw.id/core';
import { PasskeyService } from './passkey-service';

const ADDRESS = '0x1234567890123456789012345678901234567890';

function passkeyAccount(overrides: Partial<PasskeyAccount> = {}): PasskeyAccount {
  return {
    username: 'alice',
    credentialId: 'cred-alice',
    publicKey: '0xabcdef',
    creationDate: '2026-01-01T00:00:00.000Z',
    isImported: false,
    ...overrides,
  } as PasskeyAccount;
}

function fakeAccount(metadata: { username: string } | null = { username: 'alice' }): Account {
  return { address: ADDRESS, getMetadata: () => metadata } as unknown as Account;
}

describe('PasskeyService', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { hostname: 'keys.jaw.id' }, PublicKeyCredential: vi.fn() });
    vi.spyOn(console, 'error').mockImplementation(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('isWebAuthnSupported', () => {
    it('is true when the browser exposes PublicKeyCredential', () => {
      expect(new PasskeyService().isWebAuthnSupported()).toBe(true);
    });

    it('is false without PublicKeyCredential', () => {
      vi.stubGlobal('window', { location: { hostname: 'keys.jaw.id' } });
      expect(new PasskeyService().isWebAuthnSupported()).toBe(false);
    });
  });

  describe('checkAuth', () => {
    it('reports the authenticated address for the API key', () => {
      const spy = vi.spyOn(Account, 'getAuthenticatedAddress').mockReturnValue(ADDRESS);
      expect(new PasskeyService({ apiKey: 'k1' }).checkAuth()).toEqual({ isAuthenticated: true, address: ADDRESS });
      expect(spy).toHaveBeenCalledWith('k1');
    });

    it('reports not authenticated when there is no address', () => {
      vi.spyOn(Account, 'getAuthenticatedAddress').mockReturnValue(null);
      expect(new PasskeyService().checkAuth()).toEqual({ isAuthenticated: false, address: null });
    });
  });

  it('fetchAccounts returns the accounts stored for the API key', () => {
    const accounts = [passkeyAccount()];
    const spy = vi.spyOn(Account, 'getStoredAccounts').mockReturnValue(accounts);
    expect(new PasskeyService({ apiKey: 'k1' }).fetchAccounts()).toBe(accounts);
    expect(spy).toHaveBeenCalledWith('k1');
  });

  describe('createPasskey', () => {
    it('creates the account on the keys origin and returns the stored passkey', async () => {
      const stored = passkeyAccount();
      const create = vi.spyOn(Account, 'create').mockResolvedValue(fakeAccount());
      vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([stored]);

      const result = await new PasskeyService({ apiKey: 'k1', defaultChainId: 8453 }).createPasskey('alice');

      expect(create).toHaveBeenCalledWith(
        { chainId: 8453, apiKey: 'k1', rpId: 'keys.jaw.id', rpName: 'JAW' },
        { username: 'alice' }
      );
      expect(result).toEqual({
        credentialId: stored.credentialId,
        publicKey: stored.publicKey,
        address: ADDRESS,
        account: stored,
      });
    });

    it('refuses without WebAuthn', async () => {
      vi.stubGlobal('window', { location: { hostname: 'keys.jaw.id' } });
      const create = vi.spyOn(Account, 'create');
      await expect(new PasskeyService().createPasskey('alice')).rejects.toThrow('WebAuthn is not supported');
      expect(create).not.toHaveBeenCalled();
    });

    it('fails when the account has no metadata', async () => {
      vi.spyOn(Account, 'create').mockResolvedValue(fakeAccount(null));
      await expect(new PasskeyService().createPasskey('alice')).rejects.toThrow('Failed to get account metadata');
    });

    it('fails when the new passkey is not stored', async () => {
      vi.spyOn(Account, 'create').mockResolvedValue(fakeAccount());
      vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([passkeyAccount({ username: 'bob' })]);
      await expect(new PasskeyService().createPasskey('alice')).rejects.toThrow(
        'Failed to retrieve created passkey account'
      );
    });
  });

  describe('authenticateWithPasskey', () => {
    it('signs in with the chosen stored passkey', async () => {
      const stored = passkeyAccount();
      vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([passkeyAccount({ credentialId: 'other' }), stored]);
      const get = vi.spyOn(Account, 'get').mockResolvedValue(fakeAccount());

      const result = await new PasskeyService({ apiKey: 'k1', defaultChainId: 8453 }).authenticateWithPasskey(
        stored.credentialId
      );

      expect(get).toHaveBeenCalledWith({ chainId: 8453, apiKey: 'k1' }, stored.credentialId);
      expect(result).toEqual({ credentialId: stored.credentialId, address: ADDRESS, account: stored });
    });

    it('refuses without WebAuthn', async () => {
      vi.stubGlobal('window', { location: { hostname: 'keys.jaw.id' } });
      await expect(new PasskeyService().authenticateWithPasskey('cred-alice')).rejects.toThrow(
        'WebAuthn is not supported'
      );
    });

    it('fails when no passkeys are stored', async () => {
      vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([]);
      await expect(new PasskeyService().authenticateWithPasskey('cred-alice')).rejects.toThrow('No passkeys found');
    });

    it('fails without naming the credential when it is not stored', async () => {
      vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([passkeyAccount()]);
      const get = vi.spyOn(Account, 'get');

      const error = await new PasskeyService().authenticateWithPasskey('cred-missing').catch((e: Error) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('The requested passkey was not found.');
      expect((error as Error).message).not.toContain('cred-missing');
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe('importPasskeyAccount', () => {
    it('imports and returns the imported stored passkey', async () => {
      const imported = passkeyAccount({ isImported: true });
      const importSpy = vi.spyOn(Account, 'import').mockResolvedValue(fakeAccount());
      vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([passkeyAccount(), imported]);

      const result = await new PasskeyService({ apiKey: 'k1', defaultChainId: 8453 }).importPasskeyAccount();

      expect(importSpy).toHaveBeenCalledWith({ chainId: 8453, apiKey: 'k1' });
      expect(result).toEqual({ credentialId: imported.credentialId, address: ADDRESS, account: imported });
    });

    it('fails when the account has no metadata', async () => {
      vi.spyOn(Account, 'import').mockResolvedValue(fakeAccount(null));
      await expect(new PasskeyService().importPasskeyAccount()).rejects.toThrow('Failed to get account metadata');
    });

    it('fails when no imported passkey is stored for that username', async () => {
      vi.spyOn(Account, 'import').mockResolvedValue(fakeAccount());
      vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([passkeyAccount()]);
      await expect(new PasskeyService().importPasskeyAccount()).rejects.toThrow(
        'Failed to retrieve imported passkey account'
      );
    });
  });

  it('getAccount loads the account on the given chain with its paymaster', async () => {
    const account = fakeAccount();
    const get = vi.spyOn(Account, 'get').mockResolvedValue(account);
    const chain = { id: 8453, paymaster: { url: 'https://paymaster.example' } } as Chain;

    await expect(new PasskeyService({ apiKey: 'k1' }).getAccount(chain)).resolves.toBe(account);

    expect(get).toHaveBeenCalledWith({ chainId: 8453, apiKey: 'k1', paymasterUrl: 'https://paymaster.example' });
  });
});
