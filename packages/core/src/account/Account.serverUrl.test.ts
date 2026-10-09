/**
 * The passkey server an Account talks to comes from its config. The real
 * PasskeyManager runs over in-memory storage; only WebAuthn, the backend and
 * the chain are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Hex } from 'viem';
import { Account } from './Account.js';
import { createMemoryStorage } from '../storage-manager/index.js';
import {
    createPasskeyUtils,
    importPasskeyUtils,
    lookupPasskeyFromBackend,
    registerPasskeyInBackend,
} from '../passkey-manager/utils.js';

vi.mock('../passkey-manager/utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../passkey-manager/utils.js')>()),
    createPasskeyUtils: vi.fn(),
    importPasskeyUtils: vi.fn(),
    registerPasskeyInBackend: vi.fn(),
    lookupPasskeyFromBackend: vi.fn(),
}));

vi.mock('./smartAccount.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./smartAccount.js')>()),
    createSmartAccount: vi.fn(async () => ({
        address: '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62',
        getAddress: async () => '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62',
    })),
}));

vi.mock('../analytics/index.js', () => ({ logAccountIssuance: vi.fn() }));

const PUBLIC_KEY =
    '0x885d083da109f4ea0b626025ee5886d869f51817afad5a380f2b1fa9a35bccf8d52b9347c47495158ef458c338cdd15f7a902d357541d0e19d0b19e8f7ea0fd8' as Hex;
const SERVER = 'https://passkeys.example.com/passkeys';

function config(serverUrl?: string) {
    return { chainId: 8453, apiKey: 'k1', rpId: 'example.com', storage: createMemoryStorage(), serverUrl };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createPasskeyUtils).mockResolvedValue({
        credentialId: 'cred-1',
        publicKey: PUBLIC_KEY,
        webAuthnAccount: { type: 'webAuthn', publicKey: PUBLIC_KEY } as never,
    });
    vi.mocked(importPasskeyUtils).mockResolvedValue({
        credential: { id: 'cred-1', publicKey: PUBLIC_KEY },
    } as never);
    vi.mocked(lookupPasskeyFromBackend).mockResolvedValue({
        credentialId: 'cred-1',
        publicKey: PUBLIC_KEY,
        displayName: 'alice',
    });
});

describe('Account and the passkey server', () => {
    it('registers a created passkey with the configured server', async () => {
        await Account.create(config(SERVER), { username: 'alice' });

        expect(registerPasskeyInBackend).toHaveBeenCalledWith(
            { credentialId: 'cred-1', publicKey: PUBLIC_KEY, displayName: 'alice' },
            'k1',
            false,
            SERVER
        );
    });

    it('looks an imported passkey up on the configured server', async () => {
        await Account.import(config(SERVER));

        const [, , apiKey, serverUrl] = vi.mocked(importPasskeyUtils).mock.calls[0];
        expect({ apiKey, serverUrl }).toEqual({ apiKey: 'k1', serverUrl: SERVER });
        expect(lookupPasskeyFromBackend).toHaveBeenCalledWith('cred-1', 'k1', false, SERVER);
    });

    it('uses the JAW server when none is configured', async () => {
        await Account.create(config(), { username: 'alice' });
        await Account.import(config());

        expect(vi.mocked(registerPasskeyInBackend).mock.calls[0][3]).toBeUndefined();
        expect(vi.mocked(lookupPasskeyFromBackend).mock.calls[0][3]).toBeUndefined();
    });
});
