/**
 * Which account record each Account entry point resolves, and what it leaves
 * in storage. The real PasskeyManager runs over in-memory storage; only the
 * WebAuthn ceremony, the backend and the chain are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Hex } from 'viem';
import { Account, RecoveryNotFinishedError } from './Account.js';
import { createSmartAccount } from './smartAccount.js';
import { deriveAccountRecordV1, deriveAccountRecordV2, type AccountRecord } from './accountRecord.js';
import { createMemoryStorage } from '../storage-manager/index.js';
import type { PasskeyAccount } from '../passkey-manager/index.js';
import {
    PasskeyLookupError,
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

// The chain reads: whether a key is an owner of an account. Only the client is
// faked; the read it is asked to make is recorded.
const { ownerReads } = vi.hoisted(() => ({
    ownerReads: {
        owner: false as boolean | Error,
        asked: [] as Array<{ chainId: number; address: string; args: unknown }>,
    },
}));
vi.mock('viem', async (importOriginal) => {
    const actual = await importOriginal<typeof import('viem')>();
    return {
        ...actual,
        createPublicClient: vi.fn(({ chain }: { chain: { id: number } }) => ({
            readContract: async ({
                address,
                functionName,
                args,
            }: {
                address: string;
                functionName: string;
                args: unknown;
            }) => {
                if (functionName !== 'isOwnerBytes') throw new Error(`unexpected read ${functionName}`);
                ownerReads.asked.push({ chainId: chain.id, address, args });
                if (ownerReads.owner instanceof Error) throw ownerReads.owner;
                return ownerReads.owner;
            },
        })),
    };
});

// factory.getAddress([publicKey, permissionsManager], 0) on Base
const PUBLIC_KEY =
    '0x885d083da109f4ea0b626025ee5886d869f51817afad5a380f2b1fa9a35bccf8d52b9347c47495158ef458c338cdd15f7a902d357541d0e19d0b19e8f7ea0fd8' as Hex;
const ADDRESS = '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62';
// factory.getAddress([publicKey, permissionsManager, recoveryManager], 0) on Base
const ADDRESS_V2 = '0x201bcE6e444BA385F9c79d972D6b8E7dCc58e98c';
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

/** Storage that rejects every write of the stored accounts, as a full localStorage does. */
function fullStorageWith(entries: PasskeyAccount[]) {
    const storage = storageWith(entries);
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: unknown) => {
        if (key === 'accounts') throw new DOMException('quota', 'QuotaExceededError');
        setItem(key, value);
    };
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
    ownerReads.owner = false;
    ownerReads.asked = [];
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

    // A record that is not the key's is the account a recovery added it to,
    // never silently replaced by the key's own derived address.
    it('refuses a stored record that belongs to another key while the chain does not list this key as its owner', async () => {
        const foreign = deriveAccountRecordV1(OTHER_PUBLIC_KEY);
        const storage = storageWith([storedEntry({ address: foreign.address, account: foreign })]);

        const error = await Account.get(config(storage), CREDENTIAL_ID).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(RecoveryNotFinishedError);
        expect((error as RecoveryNotFinishedError).account).toBe(foreign.address);
        expect(createSmartAccount).not.toHaveBeenCalled();
    });

    it('signs in when the record cannot be stored', async () => {
        const storage = fullStorageWith([storedEntry({ address: ADDRESS })]);

        const account = await Account.get(config(storage), CREDENTIAL_ID);

        expect(account.address).toBe(ADDRESS);
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

    it('restores the session when the record cannot be stored', async () => {
        const storage = fullStorageWith([storedEntry({ address: ADDRESS })]);
        storage.setItem('authState', { isLoggedIn: true, address: ADDRESS, credentialId: CREDENTIAL_ID });

        const account = await Account.get(config(storage));

        expect(account.address).toBe(ADDRESS);
    });
});

describe('Account.restore', () => {
    // A device that keeps nothing (in-memory storage after a restart) has only
    // the key, which derives the v1 address: for a v2 account a different,
    // empty one. The backend holds the record, as on import.
    it('uses the backend record when the credential is not stored on this device, and stores nothing', async () => {
        const storage = storageWith([]);
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(deriveAccountRecordV2(PUBLIC_KEY));

        const account = await Account.restore(config(storage), CREDENTIAL_ID, PUBLIC_KEY);

        expect(account.address).toBe(ADDRESS_V2);
        expect(fetchAccountRecordFromBackend).toHaveBeenCalledWith(CREDENTIAL_ID, 'k1', false, undefined);
        expect(storedAccounts(storage)).toEqual([]);
    });

    it('fails when the credential is not stored on this device and the backend lookup fails', async () => {
        vi.mocked(fetchAccountRecordFromBackend).mockRejectedValue(new Error('503'));

        await expect(Account.restore(config(storageWith([])), CREDENTIAL_ID, PUBLIC_KEY)).rejects.toBeInstanceOf(
            PasskeyLookupError
        );
    });

    it('fails when the credential is not stored on this device and the backend record is not this key’s, while the chain does not list this key as its owner', async () => {
        const foreign = deriveAccountRecordV2(OTHER_PUBLIC_KEY);
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(foreign);

        const error = await Account.restore(config(storageWith([])), CREDENTIAL_ID, PUBLIC_KEY).catch(
            (e: unknown) => e
        );

        expect(error).toBeInstanceOf(RecoveryNotFinishedError);
        expect((error as RecoveryNotFinishedError).account).toBe(foreign.address);
        expect(createSmartAccount).not.toHaveBeenCalled();
    });

    it('does not call the backend for a credential stored on this device', async () => {
        await Account.restore(config(storageWith([storedEntry({ address: ADDRESS })])), CREDENTIAL_ID, PUBLIC_KEY);

        expect(fetchAccountRecordFromBackend).not.toHaveBeenCalled();
    });

    it('stores the record on a stored entry that has none', async () => {
        const storage = storageWith([storedEntry({ address: ADDRESS })]);

        await Account.restore(config(storage), CREDENTIAL_ID, PUBLIC_KEY);

        expect(storedAccounts(storage)[0].account).toEqual(deriveAccountRecordV1(PUBLIC_KEY));
    });

    it('restores the account when the record cannot be stored', async () => {
        const storage = fullStorageWith([storedEntry({ address: ADDRESS })]);

        const account = await Account.restore(config(storage), CREDENTIAL_ID, PUBLIC_KEY);

        expect(account.address).toBe(ADDRESS);
    });
});

describe('Account.create', () => {
    it('creates the account from its v2 record, registers that version and stores the record with it', async () => {
        const storage = storageWith([]);
        vi.mocked(createPasskeyUtils).mockResolvedValue({
            credentialId: CREDENTIAL_ID,
            publicKey: PUBLIC_KEY,
            webAuthnAccount: { type: 'webAuthn', publicKey: PUBLIC_KEY } as never,
        });

        const account = await Account.create(config(storage), { username: 'alice' });

        expect(account.address).toBe(ADDRESS_V2);
        expect(recordUsed()).toEqual(deriveAccountRecordV2(PUBLIC_KEY));
        // The backend derives the record itself; the version tells it which recipe.
        expect(vi.mocked(registerPasskeyInBackend).mock.calls[0][0]).toEqual({
            credentialId: CREDENTIAL_ID,
            publicKey: PUBLIC_KEY,
            displayName: 'alice',
            accountVersion: 2,
        });
        expect(storedAccounts(storage)[0]).toMatchObject({
            credentialId: CREDENTIAL_ID,
            address: ADDRESS_V2,
            account: deriveAccountRecordV2(PUBLIC_KEY),
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

    it('uses a v2 record the backend returns', async () => {
        const storage = storageWith([]);
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(deriveAccountRecordV2(PUBLIC_KEY));

        const account = await Account.import(config(storage));

        expect(account.address).toBe(ADDRESS_V2);
        expect(storedAccounts(storage)[0].account).toEqual(deriveAccountRecordV2(PUBLIC_KEY));
    });

    // Deriving would open the v1 address, which for a v2 account is a different,
    // empty one, with no error. The user retries instead.
    it('fails, and stores nothing, when the backend lookup fails', async () => {
        const storage = storageWith([]);
        vi.mocked(fetchAccountRecordFromBackend).mockRejectedValue(new Error('503'));

        await expect(Account.import(config(storage))).rejects.toBeInstanceOf(PasskeyLookupError);
        expect(storedAccounts(storage)).toEqual([]);
        expect(storage.getItem('authState')).toBeFalsy();
    });

    it('checksums the address of a record the backend returns in lowercase', async () => {
        const storage = storageWith([]);
        const record = deriveAccountRecordV1(PUBLIC_KEY);
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue({
            ...record,
            address: record.address.toLowerCase() as Hex,
        });

        const account = await Account.import(config(storage));

        expect(account.address).toBe(ADDRESS);
        expect(storedAccounts(storage)[0]).toMatchObject({ address: ADDRESS, account: record });
        expect(storage.getItem<{ address: string }>('authState')?.address).toBe(ADDRESS);
    });

    it('fails, and stores nothing, when the backend returns a record that is not this key’s and the chain does not list this key as its owner', async () => {
        const storage = storageWith([]);
        const foreign = deriveAccountRecordV1(OTHER_PUBLIC_KEY);
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(foreign);

        const error = await Account.import(config(storage)).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(RecoveryNotFinishedError);
        expect((error as RecoveryNotFinishedError).account).toBe(foreign.address);
        expect(storedAccounts(storage)).toEqual([]);
        expect(storage.getItem('authState')).toBeFalsy();
    });
});

/**
 * A passkey a recovery added to an existing account has a record that is not
 * its own: the account another key created. It opens that account only once
 * the chain lists it as an owner there.
 */
describe('signing in with a passkey a recovery added to an account', () => {
    const FOREIGN = deriveAccountRecordV2(OTHER_PUBLIC_KEY);

    const recoveredEntry = () => storedEntry({ address: FOREIGN.address, account: FOREIGN, isImported: true });

    function signedIn(storage: ReturnType<typeof createMemoryStorage>) {
        storage.setItem('authState', { isLoggedIn: true, address: FOREIGN.address, credentialId: CREDENTIAL_ID });
        return storage;
    }

    beforeEach(() => {
        vi.mocked(importPasskeyUtils).mockResolvedValue({
            credential: { id: CREDENTIAL_ID, publicKey: PUBLIC_KEY },
        } as never);
        vi.mocked(lookupPasskeyFromBackend).mockResolvedValue({
            credentialId: CREDENTIAL_ID,
            publicKey: PUBLIC_KEY,
            displayName: 'alice',
        });
        vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(FOREIGN);
    });

    const entryPoints = [
        ['Account.get with a credential id', () => Account.get(config(storageWith([recoveredEntry()])), CREDENTIAL_ID)],
        ['Account.get restoring the session', () => Account.get(config(signedIn(storageWith([recoveredEntry()]))))],
        [
            'Account.restore with the entry stored',
            () => Account.restore(config(storageWith([recoveredEntry()])), CREDENTIAL_ID, PUBLIC_KEY),
        ],
        [
            'Account.restore with no entry on this device',
            () => Account.restore(config(storageWith([])), CREDENTIAL_ID, PUBLIC_KEY),
        ],
        ['Account.import', () => Account.import(config(storageWith([])))],
    ] as const;

    it.each(entryPoints)(
        "%s opens the record's account once the chain lists this key as an owner there",
        async (_, signIn) => {
            ownerReads.owner = true;

            const account = await signIn();

            expect(account.address).toBe(FOREIGN.address);
            expect(recordUsed()).toEqual(FOREIGN);
            // The read is for this key, at the record's address, on the Account's chain.
            expect(ownerReads.asked).toEqual([{ chainId: 8453, address: FOREIGN.address, args: [PUBLIC_KEY] }]);
        }
    );

    it.each(entryPoints)(
        '%s refuses with RecoveryNotFinishedError, naming the account, while this key is not an owner',
        async (_, signIn) => {
            const error = await signIn().catch((e: unknown) => e);

            expect(error).toBeInstanceOf(RecoveryNotFinishedError);
            expect((error as RecoveryNotFinishedError).account).toBe(FOREIGN.address);
            expect(createSmartAccount).not.toHaveBeenCalled();
        }
    );

    it.each(entryPoints)('%s fails, rather than opening anything, when the chain cannot be read', async (_, signIn) => {
        ownerReads.owner = new Error('rpc down');

        await expect(signIn()).rejects.toMatchObject({ code: -32603 });
        expect(createSmartAccount).not.toHaveBeenCalled();
    });

    it('import stores the record, so the next sign-in checks the chain again', async () => {
        ownerReads.owner = true;
        const storage = storageWith([]);

        await Account.import(config(storage));

        expect(storedAccounts(storage)[0]).toMatchObject({ address: FOREIGN.address, account: FOREIGN });
        expect(storage.getItem<{ address: string }>('authState')?.address).toBe(FOREIGN.address);
    });

    it.each([
        [
            'Account.get with an entry stored before records existed',
            () => Account.get(config(storageWith([storedEntry()])), CREDENTIAL_ID),
        ],
        [
            "Account.get with the key's own record",
            () =>
                Account.get(
                    config(storageWith([storedEntry({ account: deriveAccountRecordV2(PUBLIC_KEY) })])),
                    CREDENTIAL_ID
                ),
        ],
        [
            "Account.restore with the key's own record from the backend",
            async () => {
                vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(deriveAccountRecordV2(PUBLIC_KEY));
                return await Account.restore(config(storageWith([])), CREDENTIAL_ID, PUBLIC_KEY);
            },
        ],
        [
            "Account.import with the key's own record",
            async () => {
                vi.mocked(fetchAccountRecordFromBackend).mockResolvedValue(deriveAccountRecordV1(PUBLIC_KEY));
                return await Account.import(config(storageWith([])));
            },
        ],
    ])('%s reads nothing from the chain', async (_, signIn) => {
        await signIn();

        expect(ownerReads.asked).toEqual([]);
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
