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
    handleGetRecoveryRequest,
    isFirstRecoverySetup,
    listCeremonies,
    minimumRecoveryDelay,
    normalizeCancelRecoveryParams,
    normalizeSetupRecoveryParams,
    planRecoveryChanges,
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

describe('planRecoveryChanges', () => {
    // The readable twin of diffRecoveryConfig: what the confirm screen lists is
    // what both doors apply, one entry per op, in the same order.
    it('names each change in the order the ops are signed', () => {
        const D = toOwnerBytes('0xdddddddddddddddddddddddddddddddddddddddd');
        const desired = {
            recoveries: [
                { commitment: A, delay: 3_600 },
                { commitment: B, delay: 60 },
                { commitment: D, delay: 60 },
            ],
            threshold: 1,
        };

        expect(planRecoveryChanges(ON_CHAIN, desired)).toEqual([
            { kind: 'add', method: { commitment: D, delay: 60, provider: PROVIDER } },
            { kind: 'threshold', threshold: 1 },
            { kind: 'remove', recoveryId: registered(A).recoveryId },
            { kind: 'add', method: { commitment: A, delay: 3_600, provider: PROVIDER } },
            { kind: 'threshold', threshold: 1 },
            { kind: 'remove', recoveryId: registered(C).recoveryId },
        ]);
    });

    it('lists one change per op diffRecoveryConfig signs', () => {
        const fewer = { recoveries: [{ commitment: A, delay: 60 }], threshold: 1 };

        expect(planRecoveryChanges(ON_CHAIN, fewer)).toHaveLength(diffRecoveryConfig(ON_CHAIN, fewer).length);
    });

    it('lists nothing for the config already on chain', () => {
        const same = { recoveries: [A, B, C].map((commitment) => ({ commitment, delay: 60 })), threshold: 2 };

        expect(planRecoveryChanges(ON_CHAIN, same)).toEqual([]);
    });
});

describe('isFirstRecoverySetup', () => {
    it('is a first setup where the manager is not an owner yet', () => {
        expect(isFirstRecoverySetup({ ...ON_CHAIN, enrolled: false, threshold: 0, recoveries: [] })).toBe(true);
    });

    it('is a first setup where the manager is an owner but holds no method', () => {
        expect(isFirstRecoverySetup({ ...ON_CHAIN, threshold: 0, recoveries: [] })).toBe(true);
    });

    it('is an edit where the account holds methods', () => {
        expect(isFirstRecoverySetup(ON_CHAIN)).toBe(false);
    });
});

describe('minimumRecoveryDelay', () => {
    const waits = (...delays: number[]) => delays.map((delay, i) => ({ commitment: [A, B, C][i], delay }));
    const HOUR = 3_600;

    it.each<[name: string, recoveries: ReturnType<typeof waits>, threshold: number, expected: number]>([
        ['one guardian alone', waits(48 * HOUR), 1, 48 * HOUR],
        ['the fastest of two when one approval is enough', waits(72 * HOUR, 24 * HOUR), 1, 24 * HOUR],
        ['the slower of two when both must approve', waits(24 * HOUR, 72 * HOUR), 2, 72 * HOUR],
        ['the threshold-th smallest wait of three', waits(7 * 24 * HOUR, 0, 48 * HOUR), 2, 48 * HOUR],
        ['zero when a guardian with no wait can recover alone', waits(0, 48 * HOUR), 1, 0],
    ])('is %s', (_name, recoveries, threshold, expected) => {
        expect(minimumRecoveryDelay(recoveries, threshold)).toBe(expected);
    });

    it('is null while the list cannot meet the threshold', () => {
        expect(minimumRecoveryDelay(waits(48 * HOUR), 2)).toBeNull();
        expect(minimumRecoveryDelay([], 1)).toBeNull();
    });

    it('is null for a threshold below one', () => {
        expect(minimumRecoveryDelay(waits(48 * HOUR), 0)).toBeNull();
    });

    it('does not reorder the list it is given', () => {
        const recoveries = waits(72 * HOUR, 24 * HOUR);
        minimumRecoveryDelay(recoveries, 1);

        expect(recoveries.map((method) => method.delay)).toEqual([72 * HOUR, 24 * HOUR]);
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

describe('handleGetRecoveryRequest', () => {
    const CONNECTED = '0x2222222222222222222222222222222222222222' as const;
    const CHAIN: RecoveryChainConfig = {
        chainId: 84_532,
        deployed: true,
        enrolled: true,
        threshold: 1,
        recoveries: [],
    };
    const PENDING = {
        requestId: ID,
        account: ACCOUNT,
        subject: SUBJECT,
        expiry: '2030-01-01T00:00:00.000Z',
        chains: [],
    };

    beforeEach(() => {
        vi.mocked(restCall).mockReset();
        vi.mocked(restCall).mockImplementation(async (route: string) =>
            route === 'GET_RECOVERY_CONFIG' ? ({ chains: [CHAIN] } as never) : ({ ceremonies: [PENDING] } as never)
        );
    });

    function reads() {
        return vi.mocked(restCall).mock.calls.map((call) => [...call]);
    }

    test('Given an address in params, When handled, Then both reads are for it and the state is composed', async () => {
        const state = await handleGetRecoveryRequest(
            { method: 'wallet_getRecovery', params: [{ address: ACCOUNT }] },
            KEY
        );

        expect(state).toEqual({ chains: [CHAIN], pending: [PENDING] });
        expect(reads()).toEqual([
            ['GET_RECOVERY_CONFIG', 'GET', {}, { 'x-api-key': KEY }, { account: ACCOUNT }],
            ['LIST_CEREMONIES', 'GET', { account: ACCOUNT, executed: 'false' }, { 'x-api-key': KEY }],
        ]);
    });

    test('Given no address but a connected account, When handled, Then the connected address is injected', async () => {
        await handleGetRecoveryRequest({ method: 'wallet_getRecovery', params: [] }, KEY, CONNECTED);

        expect(reads().map((call) => call[4] ?? call[2])).toEqual([
            { account: CONNECTED },
            { account: CONNECTED, executed: 'false' },
        ]);
    });

    test('Given an address in params and a connected account, When handled, Then the params win', async () => {
        await handleGetRecoveryRequest(
            { method: 'wallet_getRecovery', params: [{ address: ACCOUNT }] },
            KEY,
            CONNECTED
        );

        expect(reads()[0][4]).toEqual({ account: ACCOUNT });
    });

    test('Given no address and no connected account, When handled, Then it rejects with invalid params and nothing is read', async () => {
        await expect(handleGetRecoveryRequest({ method: 'wallet_getRecovery', params: [] }, KEY)).rejects.toMatchObject(
            { code: -32602, message: expect.stringContaining('address') }
        );

        expect(restCall).not.toHaveBeenCalled();
    });

    test('Given a malformed address, When handled, Then it rejects before anything is read', async () => {
        await expect(
            handleGetRecoveryRequest({ method: 'wallet_getRecovery', params: [{ address: '0xabc' }] }, KEY, CONNECTED)
        ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('address') });

        expect(restCall).not.toHaveBeenCalled();
    });
});

/** Every input that must be refused before a signing window opens. */
const REJECTED_IDS: [name: string, id: unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['empty string', ''],
    ['bare 0x', '0x'],
    ['too short', `0x${'ab'.repeat(31)}`],
    ['too long', `0x${'ab'.repeat(33)}`],
    ['no 0x prefix', 'ab'.repeat(32)],
    ['non-hex characters', `0x${'zz'.repeat(32)}`],
    ['a number', 1],
    ['an object', {}],
    // A BigInt must not crash the validator itself: a message that interpolated
    // JSON.stringify(value) would throw on one, and `request` is in-process, so
    // the dapp would see that TypeError instead of -32602.
    ['a bigint', 1n],
];

describe('normalizeCancelRecoveryParams', () => {
    it('accepts a 32-byte request id and passes the capabilities through', () => {
        expect(normalizeCancelRecoveryParams([{ requestId: ID, capabilities: { foo: 1 } }])).toEqual({
            requestId: ID,
            capabilities: { foo: 1 },
        });
    });

    it('leaves capabilities undefined when the dapp omits them', () => {
        expect(normalizeCancelRecoveryParams([{ requestId: ID }])).toEqual({
            requestId: ID,
            capabilities: undefined,
        });
    });

    it('accepts a lowercase, non-checksummed request id', () => {
        const lower = `0x${'AB'.repeat(32)}`.toLowerCase();
        expect(normalizeCancelRecoveryParams([{ requestId: lower }]).requestId).toBe(lower);
    });

    // The veto is about one ceremony, so a request that names no usable request
    // id cannot succeed and must never open a dialog over nothing.
    it.each(REJECTED_IDS)('rejects a request id that is %s with -32602', (_name, requestId) => {
        expect(() => normalizeCancelRecoveryParams([{ requestId }])).toThrow(/must be a 32-byte hex value/);
        try {
            normalizeCancelRecoveryParams([{ requestId }]);
        } catch (err) {
            expect((err as { code?: number }).code).toBe(-32602);
        }
    });

    it('rejects a malformed envelope', () => {
        for (const params of [undefined, null, [], [null], ['0x'], {}]) {
            expect(() => normalizeCancelRecoveryParams(params)).toThrow(/expected a single object parameter/);
        }
    });
});

const GUARDIAN = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const PADDED_GUARDIAN = `0x${'00'.repeat(12)}${GUARDIAN.slice(2)}` as const;
const PADDED_OTHER = `0x${'00'.repeat(12)}${'44'.repeat(20)}` as const;
const OTHER_PROVIDER = '0x5555555555555555555555555555555555555555' as const;

/** A valid proposed method, with overrides for the field under test. */
function method(overrides: Record<string, unknown> = {}) {
    return { commitment: GUARDIAN, delay: 60, ...overrides };
}

describe('normalizeSetupRecoveryParams', () => {
    // The screen only displays and approves, as for permissions: the dApp passes the whole end
    // state, so a request without it has nothing to show and is refused before any screen opens.
    it.each([
        ['no params', undefined],
        ['null params', null],
        ['an empty list', []],
        ['a null entry', [null]],
        ['an empty object', [{}]],
    ])('refuses %s with -32602: there is nothing to show', (_name, params) => {
        expect(() => normalizeSetupRecoveryParams(params)).toThrow();
        try {
            normalizeSetupRecoveryParams(params);
        } catch (err) {
            expect((err as { code?: number }).code).toBe(-32602);
        }
    });

    it('passes a proposal through, padding an address commitment to the 32 bytes the provider compares', () => {
        const capabilities = { paymasterService: { url: 'https://pm.example' } };

        expect(
            normalizeSetupRecoveryParams([
                {
                    recoveries: [
                        { commitment: GUARDIAN, delay: 172_800 },
                        { commitment: SUBJECT, delay: 0 },
                        { commitment: PADDED_OTHER, delay: 60, provider: OTHER_PROVIDER },
                    ],
                    threshold: 2,
                    capabilities,
                },
            ])
        ).toEqual({
            recoveries: [
                { commitment: PADDED_GUARDIAN, delay: 172_800 },
                { commitment: SUBJECT, delay: 0 },
                { commitment: PADDED_OTHER, delay: 60, provider: OTHER_PROVIDER },
            ],
            threshold: 2,
            capabilities,
        });
    });

    it('accepts a threshold equal to the number of methods proposed', () => {
        const params = [{ recoveries: [method(), method({ commitment: SUBJECT })], threshold: 2 }];
        expect(normalizeSetupRecoveryParams(params).threshold).toBe(2);
    });

    it('does not read keys that are not part of the proposal', () => {
        const normalized = normalizeSetupRecoveryParams([
            { recoveries: [method()], threshold: 1, address: ACCOUNT, chainId: '0x1', editable: false },
        ]);

        expect(normalized).not.toHaveProperty('address');
        expect(normalized).not.toHaveProperty('chainId');
        expect(normalized).not.toHaveProperty('editable');
    });

    it.each<[name: string, params: unknown, reason: RegExp]>([
        ['an envelope that is not a list', {}, /expected a single object parameter/],
        ['an entry that is not an object', ['0x'], /expected a single object parameter/],
        ['recoveries that is not a list', [{ recoveries: 'nope' }], /recoveries must be an array/],
        ['an empty recoveries list', [{ recoveries: [] }], /recoveries must not be empty/],
        ['a method that is not an object', [{ recoveries: [1] }], /recoveries\[0\] must be an object/],
        ['a missing commitment', [{ recoveries: [method({ commitment: undefined })] }], /commitment must be/],
        [
            'a commitment of 19 bytes',
            [{ recoveries: [method({ commitment: `0x${'ab'.repeat(19)}` })] }],
            /commitment must be/,
        ],
        [
            'a commitment of 21 bytes',
            [{ recoveries: [method({ commitment: `0x${'ab'.repeat(21)}` })] }],
            /commitment must be/,
        ],
        [
            'a commitment of 33 bytes',
            [{ recoveries: [method({ commitment: `0x${'ab'.repeat(33)}` })] }],
            /commitment must be/,
        ],
        [
            'a commitment of 65 bytes',
            [{ recoveries: [method({ commitment: `0x${'ab'.repeat(65)}` })] }],
            /commitment must be/,
        ],
        [
            'a commitment that is not hex',
            [{ recoveries: [method({ commitment: `0x${'zz'.repeat(20)}` })] }],
            /commitment must be/,
        ],
        ['a commitment that is a number', [{ recoveries: [method({ commitment: 1 })] }], /commitment must be/],
        ['a missing delay', [{ recoveries: [method({ delay: undefined })] }], /delay must be/],
        ['a negative delay', [{ recoveries: [method({ delay: -1 })] }], /delay must be/],
        ['a fractional delay', [{ recoveries: [method({ delay: 1.5 })] }], /delay must be/],
        ['a delay that is a string', [{ recoveries: [method({ delay: '60' })] }], /delay must be/],
        ['a delay that is a bigint', [{ recoveries: [method({ delay: 60n })] }], /delay must be/],
        ['a delay above uint32', [{ recoveries: [method({ delay: 2 ** 32 })] }], /delay must be/],
        [
            'a provider that is not an address',
            [{ recoveries: [method({ provider: '0xabc' })] }],
            /provider must be a 20-byte hex address/,
        ],
        ['the same method twice', [{ recoveries: [method(), method()] }], /recoveries\[1\] repeats an earlier method/],
        [
            'the same method spelled padded',
            [{ recoveries: [method(), method({ commitment: PADDED_GUARDIAN })] }],
            /repeats an earlier method/,
        ],
        [
            'the same method in another case',
            [{ recoveries: [method(), method({ commitment: `0x${GUARDIAN.slice(2).toUpperCase()}` })] }],
            /repeats an earlier method/,
        ],
        [
            'the same method with the default provider made explicit',
            [{ recoveries: [method(), method({ provider: PROVIDER })] }],
            /repeats an earlier method/,
        ],
        ['missing recoveries', [{ threshold: 1 }], /recoveries is required/],
        ['a missing threshold', [{ recoveries: [method()] }], /threshold is required/],
        ['a threshold of zero', [{ recoveries: [method()], threshold: 0 }], /threshold must be a positive integer/],
        ['a negative threshold', [{ recoveries: [method()], threshold: -1 }], /threshold must be a positive integer/],
        [
            'a fractional threshold',
            [{ recoveries: [method()], threshold: 1.5 }],
            /threshold must be a positive integer/,
        ],
        [
            'a threshold that is a string',
            [{ recoveries: [method()], threshold: '1' }],
            /threshold must be a positive integer/,
        ],
        [
            'a threshold above the methods proposed',
            [{ recoveries: [method()], threshold: 2 }],
            /threshold 2 exceeds the 1 recovery methods proposed/,
        ],
    ])('rejects %s with -32602', (_name, params, reason) => {
        expect(() => normalizeSetupRecoveryParams(params)).toThrow(reason);
        try {
            normalizeSetupRecoveryParams(params);
        } catch (err) {
            expect((err as { code?: number }).code).toBe(-32602);
        }
    });

    it('accepts a method whose provider differs from an otherwise identical one', () => {
        const params = [{ recoveries: [method(), method({ provider: OTHER_PROVIDER })], threshold: 1 }];
        expect(normalizeSetupRecoveryParams(params).recoveries).toHaveLength(2);
    });
});
