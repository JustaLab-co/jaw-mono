/**
 * Which account record each Account entry point resolves, and what it leaves
 * in storage. The real PasskeyManager runs over in-memory storage; only the
 * WebAuthn ceremony, the backend and the chain are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Hex } from 'viem';
import { Account } from './Account.js';
import { createSmartAccount } from './smartAccount.js';
import { deriveAccountRecordV1, type AccountRecord } from './accountRecord.js';
import { createMemoryStorage } from '../storage-manager/index.js';
import type { PasskeyAccount } from '../passkey-manager/index.js';
import {
    authenticateWithWebAuthnUtils,
    createPasskeyUtils,
    fetchAccountRecordFromBackend,
    importPasskeyUtils,
    lookupPasskeyFromBackend,
    registerPasskeyInBackend,
} from '../passkey-manager/utils.js';

vi.mock('../passkey-manager/utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../passkey-manager/utils.js')>()),
    authenticateWithWebAuthnUtils: vi.fn(),
    createPasskeyUtils: vi.fn(),
    importPasskeyUtils: vi.fn(),
    registerPasskeyInBackend: vi.fn(),
    lookupPasskeyFromBackend: vi.fn(),
    fetchAccountRecordFromBackend: vi.fn(),
}));

vi.mock('./smartAccount.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./smartAccount.js')>()),
    createSmartAccount: vi.fn(async (_signer: unknown, _client: unknown, record?: AccountRecord) => {
        const address = record?.address ?? '0x0000000000000000000000000000000000000bad';
        return { address, getAddress: async () => address };
    }),
}));

vi.mock('../analytics/index.js', () => ({ logAccountIssuance: vi.fn() }));

// factory.getAddress([publicKey, permissionsManager], 0) on Base
const PUBLIC_KEY =
    '0x885d083da109f4ea0b626025ee5886d869f51817afad5a380f2b1fa9a35bccf8d52b9347c47495158ef458c338cdd15f7a902d357541d0e19d0b19e8f7ea0fd8' as Hex;
const ADDRESS = '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62';
const OTHER_PUBLIC_KEY =
    '0xdebc6e2f6d482a438e57b6f3c243c6d3899115b664a81a0da8c34e062748442745c98f217813ed30da51350a533b81210a98709f513f8707e113aba0f1a8e5c8' as Hex;

const CREDENTIAL_ID = 'cred-1';

function storedEntry(overrides: Partial<PasskeyAccount> = {}): PasskeyAccount {
    return {
        username: 'alice',
        credentialId: CREDENTIAL_ID,
        publicKey: PUBLIC_KEY,
        creationDate: '2026-09-01T00:00:00.000Z',
        isImported: false,
        ...overrides,
    };
}

function storageWith(entries: PasskeyAccount[]) {
    const storage = createMemoryStorage();
    storage.setItem('accounts', entries);
    return storage;
}

function storedAccounts(storage: ReturnType<typeof createMemoryStorage>): PasskeyAccount[] {
    return storage.getItem<PasskeyAccount[]>('accounts') ?? [];
}

/** The record createSmartAccount was last handed. */
function recordUsed(): AccountRecord | undefined {
    return vi.mocked(createSmartAccount).mock.calls.at(-1)?.[2];
}

const config = (storage: ReturnType<typeof createMemoryStorage>) => ({
    chainId: 8453,
    apiKey: 'k1',
    rpId: 'example.com',
    storage,
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWithWebAuthnUtils).mockResolvedValue({} as never);
});

describe('Account.get with a credential id', () => {
    it('derives the record for an entry stored before records existed, and stores it', async () => {
        const storage = storageWith([storedEntry({ address: ADDRESS })]);

        const account = await Account.get(config(storage), CREDENTIAL_ID);

        expect(account.address).toBe(ADDRESS);
        expect(recordUsed()).toEqual(deriveAccountRecordV1(PUBLIC_KEY));
        expect(storedAccounts(storage)[0].account).toEqual(deriveAccountRecordV1(PUBLIC_KEY));
    });

    it('uses the stored record when it is the one its key creates', async () => {
        const record = deriveAccountRecordV1(PUBLIC_KEY);
        const storage = storageWith([storedEntry({ address: ADDRESS, account: record })]);

        await Account.get(config(storage), CREDENTIAL_ID);

        expect(recordUsed()).toEqual(record);
    });

    it("ignores a stored record that belongs to another key, and keeps the user's own address", async () => {
        const foreign = deriveAccountRecordV1(OTHER_PUBLIC_KEY);
        const storage = storageWith([storedEntry({ address: ADDRESS, account: foreign })]);

        const account = await Account.get(config(storage), CREDENTIAL_ID);

        expect(account.address).toBe(ADDRESS);
        expect(recordUsed()?.address).toBe(ADDRESS);
    });

    it('does not call the backend', async () => {
        const storage = storageWith([storedEntry()]);

        await Account.get(config(storage), CREDENTIAL_ID);

        expect(fetchAccountRecordFromBackend).not.toHaveBeenCalled();
    });
});

describe('Account.get restoring the signed-in session', () => {
    it('derives and stores the record for the current account', async () => {
        const storage = storageWith([storedEntry({ address: ADDRESS })]);
        storage.setItem('authState', { isLoggedIn: true, address: ADDRESS, credentialId: CREDENTIAL_ID });

        const account = await Account.get(config(storage));

        expect(account.address).toBe(ADDRESS);
        expect(storedAccounts(storage)[0].account).toEqual(deriveAccountRecordV1(PUBLIC_KEY));
    });
});

describe('Account.restore', () => {
    it('derives the record when the credential is not stored on this device, and stores nothing', async () => {
        const storage = storageWith([]);

        const account = await Account.restore(config(storage), CREDENTIAL_ID, PUBLIC_KEY);

        expect(account.address).toBe(ADDRESS);
        expect(storedAccounts(storage)).toEqual([]);
    });

    it('stores the record on a stored entry that has none', async () => {
        const storage = storageWith([storedEntry({ address: ADDRESS })]);

        await Account.restore(config(storage), CREDENTIAL_ID, PUBLIC_KEY);

        expect(storedAccounts(storage)[0].account).toEqual(deriveAccountRecordV1(PUBLIC_KEY));
    });
});

describe('Account.create', () => {
    it('creates the account from its v1 record and stores the record with it', async () => {
        const storage = storageWith([]);
        vi.mocked(createPasskeyUtils).mockResolvedValue({
            credentialId: CREDENTIAL_ID,
            publicKey: PUBLIC_KEY,
            webAuthnAccount: { type: 'webAuthn', publicKey: PUBLIC_KEY } as never,
        });

        const account = await Account.create(config(storage), { username: 'alice' });

        expect(account.address).toBe(ADDRESS);
        expect(recordUsed()).toEqual(deriveAccountRecordV1(PUBLIC_KEY));
        expect(registerPasskeyInBackend).toHaveBeenCalled();
        expect(storedAccounts(storage)[0]).toMatchObject({
            credentialId: CREDENTIAL_ID,
            address: ADDRESS,
            account: deriveAccountRecordV1(PUBLIC_KEY),
        });
    });
});

describe('Account.import', () => {
    beforeEach(() => {
        vi.mocked(importPasskeyUtils).mockResolvedValue({
            credential: { id: CREDENTIAL_ID, publicKey: PUBLIC_KEY },
        } as never);
        vi.mocked(lookupPasskeyFromBackend).mockResolvedValue({
            credentialId: CREDENTIAL_ID,
            publicKey: PUBLIC_KEY,
            displayName: 'alice',
        });
    });

    it('uses the record the backend returns and stores it', async () => {
        const storage = storageWith([]);
        const record = deriveAccountRecordV1(PUBLIC_KEY);
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(record);

        const account = await Account.import(config(storage));

        expect(account.address).toBe(ADDRESS);
        // No passkey server configured: the JAW one.
        expect(fetchAccountRecordFromBackend).toHaveBeenCalledWith(CREDENTIAL_ID, 'k1', false, undefined);
        expect(recordUsed()).toEqual(record);
        expect(storedAccounts(storage)[0].account).toEqual(record);
    });

    it('derives the record when the backend lookup fails, as before records existed', async () => {
        const storage = storageWith([]);
        vi.mocked(fetchAccountRecordFromBackend).mockRejectedValue(new Error('503'));

        const account = await Account.import(config(storage));

        expect(account.address).toBe(ADDRESS);
        expect(recordUsed()).toEqual(deriveAccountRecordV1(PUBLIC_KEY));
    });

    it('derives the record when the backend returns one that is not this key’s', async () => {
        const storage = storageWith([]);
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(deriveAccountRecordV1(OTHER_PUBLIC_KEY));

        const account = await Account.import(config(storage));

        expect(account.address).toBe(ADDRESS);
    });
});

describe('Account.backfillStoredAccountAddresses', () => {
    it('fills the address and record of old entries offline, keeping a stored address', async () => {
        const storage = storageWith([
            storedEntry(),
            storedEntry({
                credentialId: 'cred-2',
                publicKey: OTHER_PUBLIC_KEY,
                address: '0x00000000000000000000000000000000000000aa',
            }),
        ]);

        const accounts = await Account.backfillStoredAccountAddresses(config(storage));

        expect(createSmartAccount).not.toHaveBeenCalled();
        expect(accounts[0]).toMatchObject({ address: ADDRESS, account: deriveAccountRecordV1(PUBLIC_KEY) });
        expect(storedAccounts(storage)[0]).toMatchObject({
            address: ADDRESS,
            account: deriveAccountRecordV1(PUBLIC_KEY),
        });
        expect(storedAccounts(storage)[1]).toMatchObject({
            address: '0x00000000000000000000000000000000000000aa',
            account: deriveAccountRecordV1(OTHER_PUBLIC_KEY),
        });
    });

    it('leaves complete entries untouched', async () => {
        const complete = storedEntry({ address: ADDRESS, account: deriveAccountRecordV1(PUBLIC_KEY) });
        const storage = storageWith([complete]);

        const accounts = await Account.backfillStoredAccountAddresses(config(storage));

        expect(accounts).toEqual([complete]);
    });
});
