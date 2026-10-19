import { beforeEach, describe, expect, it, test, vi } from 'vitest';
import { hashTypedData, type Hex } from 'viem';
import {
    AdminOpType,
    addRecoveryOp,
    approveCeremony,
    buildRecoverySetupCalls,
    computeRecoveryId,
    createCeremony,
    diffRecoveryConfig,
    getAdminBatch,
    getCeremony,
    getRecoveryConfig,
    listCeremonies,
    recoverTypedData,
    recoveryAdminTypedData,
    submitAdminBatch,
    toOwnerBytes,
    type RecoveryChainConfig,
} from './recovery.js';
import { RECOVERY_MANAGER_ADDRESS, SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '../constants.js';
import { restCall } from '../api/index.js';

vi.mock('../api/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../api/index.js')>();
    return {
        ...actual,
        restCall: vi.fn(),
    };
});

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const PROVIDER = SIGNATURE_RECOVERY_PROVIDER_ADDRESS;
const ID = `0x${'ab'.repeat(32)}` as const;
const SUBJECT = `0x${'44'.repeat(64)}` as const;
const KEY = 'api-key';

function sentCall() {
    return vi.mocked(restCall).mock.calls.at(-1) as unknown[];
}

describe('the backend client', () => {
    beforeEach(() => {
        vi.mocked(restCall).mockReset();
        vi.mocked(restCall).mockResolvedValue({ ceremonies: [] } as never);
    });

    test('Given an API key, When the configs are read, Then the account is a path param and the key a header', async () => {
        await getRecoveryConfig(ACCOUNT, KEY);

        expect(sentCall()).toEqual(['GET_RECOVERY_CONFIG', 'GET', {}, { 'x-api-key': KEY }, { account: ACCOUNT }]);
    });

    test('Given no API key, When a route is called, Then no key header travels', async () => {
        await getRecoveryConfig(ACCOUNT);

        expect(sentCall()[3]).toEqual({});
    });

    test('Given a signed batch, When submitted, Then the body travels as it is', async () => {
        const batch = {
            account: ACCOUNT,
            ops: [addRecoveryOp({ commitment: SUBJECT, delay: 60 })],
            salt: ID,
            expiry: 2_000_000_000,
            ownerBytes: toOwnerBytes(ACCOUNT),
            proof: `0x${'cd'.repeat(65)}` as Hex,
            chainIds: [84_532, 10],
        };
        await submitAdminBatch(batch, KEY);

        expect(sentCall()).toEqual(['SUBMIT_ADMIN_BATCH', 'POST', batch, { 'x-api-key': KEY }]);
    });

    test('Given a batch id, When read, Then it is a path param', async () => {
        await getAdminBatch(ID, KEY);

        expect(sentCall()).toEqual(['GET_ADMIN_BATCH', 'GET', {}, { 'x-api-key': KEY }, { id: ID }]);
    });

    test('Given a new owner and a salt, When a ceremony is created, Then account, subject and salt are posted', async () => {
        await createCeremony({ account: ACCOUNT, subject: SUBJECT, salt: ID }, KEY);

        expect(sentCall()).toEqual([
            'CREATE_CEREMONY',
            'POST',
            { account: ACCOUNT, subject: SUBJECT, salt: ID },
            { 'x-api-key': KEY },
        ]);
    });

    test("Given a guardian's proof, When posted, Then it travels under the request id", async () => {
        const proof = `0x${'ef'.repeat(65)}` as Hex;
        await approveCeremony(ID, { recoveryId: ID, proof }, KEY);

        expect(sentCall()).toEqual([
            'APPROVE_CEREMONY',
            'POST',
            { recoveryId: ID, proof },
            { 'x-api-key': KEY },
            { requestId: ID },
        ]);
    });

    test('Given a request id, When the ceremony is read, Then it is a path param', async () => {
        await getCeremony(ID, KEY);

        expect(sentCall()).toEqual(['GET_CEREMONY', 'GET', {}, { 'x-api-key': KEY }, { requestId: ID }]);
    });

    test('Given an executed filter, When ceremonies are listed, Then it travels as the string the backend reads and the list is unwrapped', async () => {
        const entry = {
            requestId: ID,
            account: ACCOUNT,
            subject: SUBJECT,
            expiry: '2026-11-01T00:00:00.000Z',
            chains: [],
        };
        vi.mocked(restCall).mockResolvedValue({ ceremonies: [entry] } as never);

        const listed = await listCeremonies(ACCOUNT, { executed: false }, KEY);

        expect(sentCall()).toEqual([
            'LIST_CEREMONIES',
            'GET',
            { account: ACCOUNT, executed: 'false' },
            { 'x-api-key': KEY },
        ]);
        expect(listed).toEqual([entry]);
    });

    test('Given no filter, When ceremonies are listed, Then only the account travels', async () => {
        await listCeremonies(ACCOUNT, undefined, KEY);

        expect(sentCall()[2]).toEqual({ account: ACCOUNT });
    });
});

describe('the typed data the owner and the guardians sign', () => {
    it('carries no chainId in either domain, so one signature serves every chain', () => {
        const admin = recoveryAdminTypedData({ account: ACCOUNT, ops: [], salt: ID, expiry: 2_000_000_000 });
        const recover = recoverTypedData({ account: ACCOUNT, subject: SUBJECT, salt: ID, expiry: 2_000_000_000 });

        expect(admin.domain).toEqual({
            name: 'JustaRecoveryManager',
            version: '1',
            verifyingContract: RECOVERY_MANAGER_ADDRESS,
        });
        expect(recover.domain).toEqual({
            name: 'SignatureRecoveryProvider',
            version: '1',
            verifyingContract: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
        });
    });

    it('hashes the ISO expiry the backend returns and the unix seconds it signed over to the same digest', () => {
        const seconds = 2_000_000_000;
        const iso = new Date(seconds * 1000).toISOString();

        expect(hashTypedData(recoverTypedData({ account: ACCOUNT, subject: SUBJECT, salt: ID, expiry: iso }))).toBe(
            hashTypedData(recoverTypedData({ account: ACCOUNT, subject: SUBJECT, salt: ID, expiry: seconds }))
        );
    });
});

/** Every input that is neither an address nor a passkey public key. */
const REJECTED: [name: string, value: unknown][] = [
    ['missing', undefined],
    ['empty string', ''],
    ['bare 0x', '0x'],
    ['19 bytes', `0x${'ab'.repeat(19)}`],
    ['21 bytes', `0x${'ab'.repeat(21)}`],
    ['63 bytes', `0x${'ab'.repeat(63)}`],
    ['65 bytes', `0x${'ab'.repeat(65)}`],
    ['no 0x prefix', 'ab'.repeat(20)],
    ['non-hex characters', `0x${'zz'.repeat(20)}`],
];

describe('toOwnerBytes', () => {
    it('pads an address and keeps a public key', () => {
        expect(toOwnerBytes(ACCOUNT)).toBe(`0x${'00'.repeat(12)}${ACCOUNT.slice(2)}`);
        expect(toOwnerBytes(SUBJECT)).toBe(SUBJECT);
    });

    it.each(REJECTED)('rejects %s with -32602', (_name, value) => {
        expect(() => toOwnerBytes(value as never)).toThrow(/20-byte address or a 64-byte public key/);
        try {
            toOwnerBytes(value as never);
        } catch (err) {
            expect((err as { code?: number }).code).toBe(-32602);
        }
    });
});

const A = toOwnerBytes('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const B = toOwnerBytes('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const C = toOwnerBytes('0xcccccccccccccccccccccccccccccccccccccccc');

function registered(commitment: Hex, delay = 60) {
    return { recoveryId: computeRecoveryId(ACCOUNT, PROVIDER, commitment), provider: PROVIDER, commitment, delay };
}

/** Three guardians, any two approve: the config the demo account carries. */
const ON_CHAIN: RecoveryChainConfig = {
    chainId: 84_532,
    deployed: true,
    enrolled: true,
    threshold: 2,
    recoveries: [registered(A), registered(B), registered(C)],
};

const types = (ops: ReturnType<typeof diffRecoveryConfig>) => ops.map((op) => op.opType);

describe('diffRecoveryConfig', () => {
    it('emits nothing for the config already on chain', () => {
        const same = { recoveries: [A, B, C].map((commitment) => ({ commitment, delay: 60 })), threshold: 2 };

        expect(diffRecoveryConfig(ON_CHAIN, same)).toEqual([]);
    });

    it('adds a new method in one op', () => {
        const D = toOwnerBytes('0xdddddddddddddddddddddddddddddddddddddddd');
        const more = { recoveries: [A, B, C, D].map((commitment) => ({ commitment, delay: 60 })), threshold: 2 };

        expect(types(diffRecoveryConfig(ON_CHAIN, more))).toEqual([AdminOpType.ADD_RECOVERY]);
    });

    it('sets the threshold before the removals, so no removal drops below it', () => {
        const fewer = { recoveries: [{ commitment: A, delay: 60 }], threshold: 1 };

        expect(types(diffRecoveryConfig(ON_CHAIN, fewer))).toEqual([
            AdminOpType.SET_THRESHOLD,
            AdminOpType.REMOVE_RECOVERY,
            AdminOpType.REMOVE_RECOVERY,
        ]);
    });

    it('changes a delay as a remove and an add of the same commitment, behind a threshold of one', () => {
        const slower = {
            recoveries: [
                { commitment: A, delay: 3_600 },
                { commitment: B, delay: 60 },
                { commitment: C, delay: 60 },
            ],
            threshold: 2,
        };

        const ops = diffRecoveryConfig(ON_CHAIN, slower);

        expect(types(ops)).toEqual([
            AdminOpType.SET_THRESHOLD,
            AdminOpType.REMOVE_RECOVERY,
            AdminOpType.ADD_RECOVERY,
            AdminOpType.SET_THRESHOLD,
        ]);
        expect(ops[2]).toEqual(addRecoveryOp({ commitment: A, delay: 3_600 }));
    });

    it.each([0, 4])('refuses a threshold of %i for three methods with -32602', (threshold) => {
        const config = { recoveries: [A, B, C].map((commitment) => ({ commitment, delay: 60 })), threshold };

        expect(() => diffRecoveryConfig(ON_CHAIN, config)).toThrow(/between 1 and 3/);
        try {
            diffRecoveryConfig(ON_CHAIN, config);
        } catch (err) {
            expect((err as { code?: number }).code).toBe(-32602);
        }
    });
});

describe('buildRecoverySetupCalls', () => {
    const wanted = { recoveries: [A, B].map((commitment) => ({ commitment, delay: 60 })), threshold: 2 };

    it('enrols the manager first on a chain that has not, then adds and sets the threshold', () => {
        const fresh: RecoveryChainConfig = {
            chainId: 84_532,
            deployed: false,
            enrolled: false,
            threshold: 0,
            recoveries: [],
        };

        const calls = buildRecoverySetupCalls(ACCOUNT, fresh, wanted);

        expect(calls).toHaveLength(4);
        expect(calls[0].to).toBe(ACCOUNT);
        expect(calls.slice(1).map((call) => call.to)).toEqual(Array(3).fill(RECOVERY_MANAGER_ADDRESS));
    });

    it('skips the enrolment on a chain that already has it', () => {
        const enrolled: RecoveryChainConfig = {
            chainId: 84_532,
            deployed: true,
            enrolled: true,
            threshold: 0,
            recoveries: [],
        };

        expect(buildRecoverySetupCalls(ACCOUNT, enrolled, wanted).map((call) => call.to)).toEqual(
            Array(3).fill(RECOVERY_MANAGER_ADDRESS)
        );
    });

    it('sends nothing on a chain that already holds the config', () => {
        const same = { recoveries: [A, B, C].map((commitment) => ({ commitment, delay: 60 })), threshold: 2 };

        expect(buildRecoverySetupCalls(ACCOUNT, ON_CHAIN, same)).toEqual([]);
    });
});
