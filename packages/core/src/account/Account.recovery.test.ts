/**
 * Which door each recovery operation takes and what leaves the account. The
 * real planner and the real signer run; only the backend and the chain are
 * faked, so the proof inside a relayed batch is a signature this test recovers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    decodeAbiParameters,
    decodeFunctionData,
    getAddress,
    parseAbi,
    parseAbiParameters,
    recoverTypedDataAddress,
    type Address,
    type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Account } from './Account.js';
import { sendTransaction } from './smartAccount.js';
import { restCall } from '../api/index.js';
import { RECOVERY_MANAGER_ADDRESS, SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '../constants.js';
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

vi.mock('./smartAccount.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./smartAccount.js')>()),
    createSmartAccount: vi.fn(async () => ({ address: ACCOUNT, getAddress: async () => ACCOUNT })),
    createSmartAccountEip7702: vi.fn(async () => ({ address: ACCOUNT, getAddress: async () => ACCOUNT })),
    sendTransaction: vi.fn(async () => TX_HASH),
    getBundlerClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../analytics/index.js', () => ({ logAccountIssuance: vi.fn() }));

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

const CONTRACT_ABI = parseAbi([
    'function addOwnerAddress(address owner)',
    'function addRecovery(address account, address provider, bytes commitment, uint32 delay) returns (bytes32)',
    'function removeRecovery(address account, bytes32 recoveryId)',
    'function setRecoveryThreshold(address account, uint256 threshold)',
    'function cancelRecoveryRequest(bytes32 requestId)',
]);

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

/** The calls handed to the userOp, decoded with an ABI written from the Solidity. */
function sentCalls() {
    const [, calls] = vi.mocked(sendTransaction).mock.calls[0];
    return calls.map((call) => {
        const { functionName, args } = decodeFunctionData({ abi: CONTRACT_ABI, data: call.data as Hex });
        return { to: getAddress(call.to), functionName, args };
    });
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

    it('takes the account door on a chain the manager does not own yet, enrolling it first', async () => {
        backend.chains[0] = chain(CONNECTED, { enrolled: false, threshold: 0, recoveries: [] });

        const result = await (
            await account()
        ).setupRecovery(TWO_OF_TWO, 'https://paymaster.example', { token: '0xdead' });

        expect(backend.submitted).toEqual([]);
        expect(sentCalls()).toEqual([
            { to: ACCOUNT, functionName: 'addOwnerAddress', args: [getAddress(RECOVERY_MANAGER_ADDRESS)] },
            {
                to: RECOVERY_MANAGER_ADDRESS,
                functionName: 'addRecovery',
                args: [ACCOUNT, getAddress(PROVIDER), G1, 60],
            },
            {
                to: RECOVERY_MANAGER_ADDRESS,
                functionName: 'addRecovery',
                args: [ACCOUNT, getAddress(PROVIDER), G2, 60],
            },
            { to: RECOVERY_MANAGER_ADDRESS, functionName: 'setRecoveryThreshold', args: [ACCOUNT, 2n] },
        ]);
        const [, , , paymasterUrl, paymasterContext] = vi.mocked(sendTransaction).mock.calls[0];
        expect(paymasterUrl).toBe('https://paymaster.example');
        expect(paymasterContext).toEqual({ token: '0xdead' });
        expect(result).toEqual({
            door: 'account',
            chains: [{ chainId: CONNECTED, status: 'COMPLETED', txHash: TX_HASH }],
        });
    });

    it('takes the account door on an enrolled chain with no config yet, without enrolling again', async () => {
        backend.chains[0] = chain(CONNECTED, { threshold: 0, recoveries: [] });

        await (await account()).setupRecovery(TWO_OF_TWO);

        expect(sentCalls().map((call) => call.functionName)).toEqual([
            'addRecovery',
            'addRecovery',
            'setRecoveryThreshold',
        ]);
    });

    it('keeps an EIP-7702 account on the account door even with a config, and hands the send its key', async () => {
        await (await account({ eip7702: true })).setupRecovery(TWO_OF_TWO);

        expect(backend.submitted).toEqual([]);
        expect(sentCalls().map((call) => call.functionName)).toEqual(['addRecovery', 'setRecoveryThreshold']);
        const [, , , , , , ownerSetup] = vi.mocked(sendTransaction).mock.calls[0];
        expect(ownerSetup).toEqual({ kind: 'eip7702', localAccount: OWNER });
    });

    it('refuses a connected chain the backend does not support, before anything is signed or sent', async () => {
        backend.chains = [chain(10)];

        await expect((await account()).setupRecovery(TWO_OF_TWO)).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining(`chain ${CONNECTED}`),
        });

        expect(backend.submitted).toEqual([]);
        expect(sendTransaction).not.toHaveBeenCalled();
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

    it('cancels through the account door for an EIP-7702 account, on the connected chain', async () => {
        const result = await (await account({ eip7702: true })).cancelRecovery(REQUEST_ID);

        expect(backend.submitted).toEqual([]);
        expect(sentCalls()).toEqual([
            { to: RECOVERY_MANAGER_ADDRESS, functionName: 'cancelRecoveryRequest', args: [REQUEST_ID] },
        ]);
        expect(result).toEqual({
            door: 'account',
            chains: [{ chainId: CONNECTED, status: 'COMPLETED', txHash: TX_HASH }],
        });
    });

    it('refuses for an EIP-7702 account when the request is not pending on the connected chain', async () => {
        backend.ceremony = ceremony([
            [CONNECTED, 'EXECUTED'],
            [10, 'REQUESTED'],
        ]);

        await expect((await account({ eip7702: true })).cancelRecovery(REQUEST_ID)).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining(`chain ${CONNECTED}`),
        });

        expect(sendTransaction).not.toHaveBeenCalled();
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
