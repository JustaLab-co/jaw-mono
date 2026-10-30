/**
 * Where each recovery operation is relayed and what leaves the account: one
 * signed batch, to the networks that can take it. The real planner and the
 * real signer run; only the backend and the chain reads are faked, so the
 * proof inside a relayed batch is a signature this test recovers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeAbiParameters, parseAbiParameters, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Account } from './Account.js';
import { sendTransaction } from './smartAccount.js';
import { restCall } from '../api/index.js';
import { SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '../constants.js';
import { createMemoryStorage } from '../storage-manager/index.js';
import { deriveAccountRecordV1, deriveAccountRecordV2, type AccountRecord } from './accountRecord.js';
import {
    AdminOpType,
    computeRecoveryId,
    recoveryAdminTypedData,
    toOwnerBytes,
    type Ceremony,
    type CeremonyChainStatus,
    type RecoveryChainConfig,
    type SubmitAdminBatchRequest,
} from '../rpc/recovery.js';

const { ACCOUNT, TX_HASH } = vi.hoisted(() => ({
    ACCOUNT: '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62' as const,
    TX_HASH: `0x${'aa'.repeat(32)}` as const,
}));

// A passkey account deploys from its record, so its factory data is the record's own.
vi.mock('./smartAccount.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./smartAccount.js')>()),
    createSmartAccount: vi.fn(async (_owner: unknown, _client: unknown, record?: AccountRecord) => {
        const { accountRecordFactoryData } = await import('./accountRecord.js');
        return {
            address: ACCOUNT,
            getAddress: async () => ACCOUNT,
            getFactoryArgs: async () =>
                record
                    ? { factory: record.factory, factoryData: accountRecordFactoryData(record) }
                    : { factory: undefined, factoryData: undefined },
        };
    }),
    createSmartAccountEip7702: vi.fn(async () => ({ address: ACCOUNT, getAddress: async () => ACCOUNT })),
    sendTransaction: vi.fn(async () => TX_HASH),
    getBundlerClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../analytics/index.js', () => ({ logAccountIssuance: vi.fn() }));

// The chain reads: whether the signing key owns the account on each network.
// Only the client is faked; the request it is asked to make is checked below.
const { ownerReads } = vi.hoisted(() => ({
    ownerReads: { owned: new Map<number, boolean | Error>(), asked: [] as Array<{ chainId: number; args: unknown }> },
}));
vi.mock('viem', async (importOriginal) => {
    const actual = await importOriginal<typeof import('viem')>();
    return {
        ...actual,
        createPublicClient: vi.fn(({ chain }: { chain: { id: number } }) => ({
            readContract: async ({ functionName, args }: { functionName: string; args: unknown }) => {
                if (functionName !== 'isOwnerBytes') throw new Error(`unexpected read ${functionName}`);
                ownerReads.asked.push({ chainId: chain.id, args });
                const owned = ownerReads.owned.get(chain.id) ?? false;
                if (owned instanceof Error) throw owned;
                return owned;
            },
        })),
    };
});

// Only the calls that reach the backend are faked. The planner, the typed data
// and the signature stay real, so a test that asserts on a batch is asserting
// on the bytes the relayer would receive.
vi.mock('../api/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/index.js')>()),
    restCall: vi.fn(),
}));

// anvil's second default key, so a wrong recovered address reads as an address
const OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PROVIDER = SIGNATURE_RECOVERY_PROVIDER_ADDRESS;
const G1 = toOwnerBytes('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const G2 = toOwnerBytes('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const REQUEST_ID = `0x${'cd'.repeat(32)}` as const;
const BATCH_ID = `0x${'11'.repeat(32)}` as const;
const CONNECTED = 84_532;

function method(commitment: Hex, delay = 60) {
    return { recoveryId: computeRecoveryId(ACCOUNT, PROVIDER, commitment), provider: PROVIDER, commitment, delay };
}

function chain(chainId: number, overrides: Partial<RecoveryChainConfig> = {}): RecoveryChainConfig {
    return { chainId, deployed: true, enrolled: true, threshold: 1, recoveries: [method(G1)], ...overrides };
}

function ceremony(statuses: Array<[number, CeremonyChainStatus]>): Ceremony {
    return {
        requestId: REQUEST_ID,
        account: ACCOUNT,
        subject: G2,
        salt: `0x${'22'.repeat(32)}`,
        expiry: '2026-11-01T00:00:00.000Z',
        threshold: 1,
        collected: 1,
        guardians: [],
        chains: statuses.map(([chainId, status]) => ({
            chainId,
            status,
            executeAt: null,
            requestTxHash: null,
            executeTxHash: null,
        })),
    };
}

/** What the backend holds for the account, and what it received. */
let backend: { chains: RecoveryChainConfig[]; ceremony: Ceremony; submitted: SubmitAdminBatchRequest[] };

beforeEach(() => {
    backend = {
        chains: [
            chain(CONNECTED),
            chain(10),
            chain(8453, { deployed: false, enrolled: false, threshold: 0, recoveries: [] }),
        ],
        ceremony: ceremony([
            [CONNECTED, 'REQUESTED'],
            [10, 'PENDING'],
            [8453, 'EXECUTED'],
        ]),
        submitted: [],
    };
    ownerReads.owned = new Map([
        [CONNECTED, true],
        [10, true],
    ]);
    ownerReads.asked = [];
    vi.mocked(sendTransaction).mockClear();
    vi.mocked(restCall).mockReset();
    vi.mocked(restCall).mockImplementation((async (route: string, _method: string, request: unknown) => {
        switch (route) {
            case 'GET_RECOVERY_CONFIG':
                return { chains: backend.chains };
            case 'SUBMIT_ADMIN_BATCH': {
                const batch = request as SubmitAdminBatchRequest;
                backend.submitted.push(batch);
                return {
                    id: BATCH_ID,
                    expiry: new Date(batch.expiry * 1000).toISOString(),
                    chains: batch.chainIds.map((chainId) => ({ chainId, status: 'PENDING', txHash: null })),
                };
            }
            case 'GET_CEREMONY':
                return backend.ceremony;
            case 'LIST_CEREMONIES':
                return { ceremonies: [backend.ceremony] };
            default:
                throw new Error(`unexpected route ${route}`);
        }
    }) as never);
});

async function account(options?: { eip7702?: boolean }) {
    return await Account.fromLocalAccount({ chainId: CONNECTED, apiKey: 'api-key' }, OWNER, options);
}

const PUBLIC_KEY =
    '0x885d083da109f4ea0b626025ee5886d869f51817afad5a380f2b1fa9a35bccf8d52b9347c47495158ef458c338cdd15f7a902d357541d0e19d0b19e8f7ea0fd8' as Hex;

/** A passkey account opened from this device's entry, created from `record`. */
async function passkeyAccount(record: AccountRecord) {
    const storage = createMemoryStorage();
    storage.setItem('accounts', [
        {
            username: 'alice',
            credentialId: 'cred-1',
            publicKey: PUBLIC_KEY,
            address: ACCOUNT,
            account: record,
            creationDate: '2026-10-29T00:00:00.000Z',
            isImported: false,
        },
    ]);
    return await Account.restore({ chainId: CONNECTED, apiKey: 'api-key', storage }, 'cred-1', PUBLIC_KEY);
}

async function signerOf(batch: SubmitAdminBatchRequest): Promise<Address> {
    return await recoverTypedDataAddress({
        ...recoveryAdminTypedData({ account: ACCOUNT, ops: batch.ops, salt: batch.salt, expiry: batch.expiry }),
        signature: batch.proof,
    });
}

const TWO_OF_TWO = {
    recoveries: [
        { commitment: G1, delay: 60 },
        { commitment: G2, delay: 60 },
    ],
    threshold: 2,
};

describe('setupRecovery', () => {
    it('relays one signed batch to every deployed and enrolled chain when the connected chain has a config', async () => {
        const result = await (await account()).setupRecovery(TWO_OF_TWO);

        expect(sendTransaction).not.toHaveBeenCalled();
        const [batch] = backend.submitted;
        expect(batch.account).toBe(ACCOUNT);
        expect(batch.chainIds).toEqual([CONNECTED, 10]);
        expect(batch.ops.map((op) => op.opType)).toEqual([AdminOpType.ADD_RECOVERY, AdminOpType.SET_THRESHOLD]);
        expect(batch.ownerBytes).toBe(toOwnerBytes(OWNER.address));
        expect(await signerOf(batch)).toBe(OWNER.address);
        expect(result).toEqual({
            door: 'relay',
            batchId: BATCH_ID,
            chains: [
                { chainId: CONNECTED, status: 'PENDING', txHash: null },
                { chainId: 10, status: 'PENDING', txHash: null },
            ],
        });
    });

    it('signs an expiry inside the window the backend accepts', async () => {
        const before = Math.floor(Date.now() / 1000);
        await (await account()).setupRecovery(TWO_OF_TWO);
        const after = Math.floor(Date.now() / 1000);

        const [batch] = backend.submitted;
        expect(batch.expiry).toBeGreaterThan(before);
        expect(batch.expiry).toBeLessThanOrEqual(after + 600);
    });

    it('sends nothing when the chain already holds the config', async () => {
        const same = { recoveries: [{ commitment: G1, delay: 60 }], threshold: 1 };

        const result = await (await account()).setupRecovery(same);

        expect(result).toEqual({ door: 'relay', chains: [] });
        expect(backend.submitted).toEqual([]);
        expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('relays a first setup as one signed batch, with no transaction', async () => {
        backend.chains = [
            chain(CONNECTED, { threshold: 0, recoveries: [] }),
            chain(10, { threshold: 0, recoveries: [] }),
            chain(8453, { deployed: false, enrolled: false, threshold: 0, recoveries: [] }),
        ];

        const result = await (await account()).setupRecovery(TWO_OF_TWO);

        expect(sendTransaction).not.toHaveBeenCalled();
        const [batch] = backend.submitted;
        expect(batch.chainIds).toEqual([CONNECTED, 10]);
        expect(batch.ops.map((op) => op.opType)).toEqual([
            AdminOpType.ADD_RECOVERY,
            AdminOpType.ADD_RECOVERY,
            AdminOpType.SET_THRESHOLD,
        ]);
        expect(await signerOf(batch)).toBe(OWNER.address);
        expect(result.door).toBe('relay');
    });

    it('relays an EIP-7702 account too, signed by its key as an owner', async () => {
        await (await account({ eip7702: true })).setupRecovery(TWO_OF_TWO);

        expect(sendTransaction).not.toHaveBeenCalled();
        const [batch] = backend.submitted;
        expect(batch.chainIds).toEqual([CONNECTED, 10]);
        expect(batch.ownerBytes).toBe(toOwnerBytes(OWNER.address));
        expect(await signerOf(batch)).toBe(OWNER.address);
    });

    it('asks each deployed network with the manager whether the signing key is an owner, and no other', async () => {
        await (await account()).setupRecovery(TWO_OF_TWO);

        expect(ownerReads.asked).toEqual([
            { chainId: CONNECTED, args: [toOwnerBytes(OWNER.address)] },
            { chainId: 10, args: [toOwnerBytes(OWNER.address)] },
        ]);
    });

    it('leaves out a network where the manager is not an owner', async () => {
        backend.chains[1] = chain(10, { enrolled: false, threshold: 0, recoveries: [] });

        await (await account()).setupRecovery(TWO_OF_TWO);

        expect(backend.submitted[0].chainIds).toEqual([CONNECTED]);
    });

    it('leaves out a network where the signing key is not an owner', async () => {
        ownerReads.owned.set(10, false);

        await (await account()).setupRecovery(TWO_OF_TWO);

        expect(backend.submitted[0].chainIds).toEqual([CONNECTED]);
    });

    it('leaves out a network whose guardians differ, so the same change cannot fail it', async () => {
        backend.chains[1] = chain(10, { recoveries: [method(G2)] });

        await (await account()).setupRecovery(TWO_OF_TWO);

        expect(backend.submitted[0].chainIds).toEqual([CONNECTED]);
    });

    it('plans from the first ready network when the connected one has no account', async () => {
        backend.chains[0] = chain(CONNECTED, { deployed: false, enrolled: false, threshold: 0, recoveries: [] });
        backend.chains[1] = chain(10, { recoveries: [method(G1), method(G2)], threshold: 2 });

        const result = await (await account()).setupRecovery(TWO_OF_TWO);

        expect(result).toEqual({ door: 'relay', chains: [] });
        expect(backend.submitted).toEqual([]);
    });

    it('relays to the networks with recovery even when the connected one has none', async () => {
        backend.chains = [chain(10), chain(8453)];
        ownerReads.owned.set(8453, true);

        await (await account()).setupRecovery(TWO_OF_TWO);

        expect(backend.submitted[0].chainIds).toEqual([10, 8453]);
    });

    it('refuses when no network can take the change, before anything is signed or sent', async () => {
        backend.chains = [chain(CONNECTED, { deployed: false, enrolled: false, threshold: 0, recoveries: [] })];

        await expect((await account()).setupRecovery(TWO_OF_TWO)).rejects.toMatchObject({ code: -32602 });

        expect(backend.submitted).toEqual([]);
        expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('fails before signing when a network cannot be read, rather than skip it or let it reject the batch', async () => {
        ownerReads.owned.set(10, new Error('rpc down'));

        await expect((await account()).setupRecovery(TWO_OF_TWO)).rejects.toMatchObject({
            code: -32603,
            message: expect.stringContaining('chain 10'),
        });

        expect(backend.submitted).toEqual([]);
    });
});

describe('getRecoveryNetworks', () => {
    it('says which networks a change would reach and why the others would not', async () => {
        backend.chains[1] = chain(10, { recoveries: [method(G2)] });

        const { base, networks } = await (await account()).getRecoveryNetworks();

        expect(base?.chainId).toBe(CONNECTED);
        expect(networks.map(({ chainId, status }) => [chainId, status])).toEqual([
            [CONNECTED, 'ready'],
            [10, 'out-of-sync'],
            [8453, 'not-deployed'],
        ]);
    });

    it.each([
        [
            'a 7702 account, whose sends delegate it and add the manager and itself',
            () => account({ eip7702: true }),
            ['not-deployed', 'not-available', 'not-owner'],
        ],
        ['a local-key account, whose sends add the manager', () => account(), ['not-deployed', 'not-available']],
        [
            'a passkey account whose starting owners hold the manager',
            () => passkeyAccount(deriveAccountRecordV2(PUBLIC_KEY)),
            ['not-deployed'],
        ],
        ['a passkey account created before recovery', () => passkeyAccount(deriveAccountRecordV1(PUBLIC_KEY)), []],
    ])('marks the networks one transaction would fix, for %s', async (_, open, fixed) => {
        backend.chains = [
            chain(CONNECTED, { deployed: false, enrolled: false, threshold: 0, recoveries: [] }),
            chain(10, { enrolled: false, threshold: 0, recoveries: [] }),
            chain(8453),
            chain(42_161),
        ];
        ownerReads.owned = new Map([[42_161, true]]);

        const { networks } = await (await open()).getRecoveryNetworks();

        expect(networks.map(({ status }) => status)).toEqual(['not-deployed', 'not-available', 'not-owner', 'ready']);
        expect(networks.filter((network) => network.enabledByTransaction).map(({ status }) => status)).toEqual(fixed);
    });
});

describe('cancelRecovery', () => {
    it('relays one cancel op to the chains where the request is pending or requested', async () => {
        const result = await (await account()).cancelRecovery(REQUEST_ID);

        const [batch] = backend.submitted;
        expect(batch.chainIds).toEqual([CONNECTED, 10]);
        expect(batch.ops.map((op) => op.opType)).toEqual([AdminOpType.CANCEL_REQUEST]);
        expect(decodeAbiParameters(parseAbiParameters('bytes32 requestId'), batch.ops[0].data)[0]).toBe(REQUEST_ID);
        expect(await signerOf(batch)).toBe(OWNER.address);
        expect(result.door).toBe('relay');
        expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('refuses a request that is pending nowhere, and sends nothing', async () => {
        backend.ceremony = ceremony([
            [CONNECTED, 'EXECUTED'],
            [10, 'CANCELLED'],
        ]);

        await expect((await account()).cancelRecovery(REQUEST_ID)).rejects.toMatchObject({ code: -32602 });

        expect(backend.submitted).toEqual([]);
        expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('relays the cancel for an EIP-7702 account too', async () => {
        const result = await (await account({ eip7702: true })).cancelRecovery(REQUEST_ID);

        expect(sendTransaction).not.toHaveBeenCalled();
        expect(backend.submitted[0].chainIds).toEqual([CONNECTED, 10]);
        expect(result.door).toBe('relay');
    });

    it('leaves out a pending network where the signing key is not an owner', async () => {
        ownerReads.owned.set(10, false);

        await (await account()).cancelRecovery(REQUEST_ID);

        expect(backend.submitted[0].chainIds).toEqual([CONNECTED]);
    });

    it('refuses when the signing key owns the account on none of the pending networks, and sends nothing', async () => {
        ownerReads.owned = new Map();

        await expect((await account()).cancelRecovery(REQUEST_ID)).rejects.toMatchObject({ code: -32602 });

        expect(backend.submitted).toEqual([]);
    });
});

describe('getRecovery', () => {
    it('returns the config per chain and the ceremonies not executed anywhere', async () => {
        const state = await (await account()).getRecovery();

        expect(state).toEqual({ chains: backend.chains, pending: [backend.ceremony] });
        const list = vi.mocked(restCall).mock.calls.find((call) => call[0] === 'LIST_CEREMONIES');
        expect(list?.[2]).toEqual({ account: ACCOUNT, executed: 'false' });
    });
});
