/**
 * The owner setup each kind of account hands its own sends: what the send adds
 * before the calls when the account lacks it (see smartAccount.ownerSetup.test).
 * Only the smart account factories and the send are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Account } from './Account.js';
import { sendTransaction } from './smartAccount.js';
import { createMemoryStorage } from '../storage-manager/index.js';
import { deriveAccountRecordV2 } from './accountRecord.js';

const { ACCOUNT, OTHER_ACCOUNT } = vi.hoisted(() => ({
    ACCOUNT: '0x201bcE6e444BA385F9c79d972D6b8E7dCc58e98c' as const,
    OTHER_ACCOUNT: '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62' as const,
}));

vi.mock('./smartAccount.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./smartAccount.js')>()),
    createSmartAccount: vi.fn(async () => ({ address: ACCOUNT, getAddress: async () => ACCOUNT })),
    createSmartAccountEip7702: vi.fn(async () => ({ address: ACCOUNT, getAddress: async () => ACCOUNT })),
    createSmartAccountForAddress: vi.fn(async () => ({
        address: OTHER_ACCOUNT,
        getAddress: async () => OTHER_ACCOUNT,
    })),
    sendTransaction: vi.fn(async () => `0x${'aa'.repeat(32)}`),
    getBundlerClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../analytics/index.js', () => ({ logAccountIssuance: vi.fn() }));

const KEY = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PUBLIC_KEY =
    '0x885d083da109f4ea0b626025ee5886d869f51817afad5a380f2b1fa9a35bccf8d52b9347c47495158ef458c338cdd15f7a902d357541d0e19d0b19e8f7ea0fd8' as Hex;
const CONFIG = { chainId: 84532, apiKey: 'k1' };
const CALLS = [{ to: '0x000000000000000000000000000000000000beef' as const }];

/** The owner setup the last send was handed. */
function ownerSetupSent() {
    return vi.mocked(sendTransaction).mock.calls.at(-1)?.[6];
}

beforeEach(() => {
    vi.mocked(sendTransaction).mockClear();
});

describe('the owner setup an account hands its sends', () => {
    it('is the recovery manager for a factory account owned by a local key', async () => {
        await (await Account.fromLocalAccount(CONFIG, KEY)).sendTransaction(CALLS);

        expect(ownerSetupSent()).toEqual({ kind: 'localKey' });
    });

    it('is the EIP-7702 setup, with its key, for a 7702 account', async () => {
        await (await Account.fromLocalAccount(CONFIG, KEY, { eip7702: true })).sendTransaction(CALLS);

        expect(ownerSetupSent()).toEqual({ kind: 'eip7702', localAccount: KEY });
    });

    it('is nothing for a passkey account, whose record holds every owner', async () => {
        const storage = createMemoryStorage();
        storage.setItem('accounts', [
            {
                username: 'alice',
                credentialId: 'cred-1',
                publicKey: PUBLIC_KEY,
                address: ACCOUNT,
                account: deriveAccountRecordV2(PUBLIC_KEY),
                creationDate: '2026-10-29T00:00:00.000Z',
                isImported: false,
            },
        ]);

        await (await Account.restore({ ...CONFIG, storage }, 'cred-1', PUBLIC_KEY)).sendTransaction(CALLS);

        expect(ownerSetupSent()).toBeUndefined();
    });

    it('is nothing when a 7702 account sends from another account its key also owns', async () => {
        const account = await Account.fromLocalAccount(CONFIG, KEY, { eip7702: true });

        await account.sendTransaction(CALLS, undefined, undefined, OTHER_ACCOUNT);

        expect(ownerSetupSent()).toBeUndefined();
    });
});
