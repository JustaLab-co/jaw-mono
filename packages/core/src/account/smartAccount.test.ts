import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type Hex, type Address } from 'viem';

vi.mock('viem/actions', () => ({
    getCode: vi.fn(),
    readContract: vi.fn(),
    multicall: vi.fn(),
    getGasPrice: vi.fn(),
    call: vi.fn(),
    getBlockNumber: vi.fn(),
    getLogs: vi.fn(),
    getTransactionReceipt: vi.fn(),
}));

vi.mock('./toJustanAccount.js', () => ({
    toJustanAccount: vi.fn(),
    abi: [
        {
            name: 'nextOwnerIndex',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'uint256' }],
        },
        {
            name: 'ownerCount',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'uint256' }],
        },
        {
            name: 'ownerAtIndex',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ type: 'uint256' }],
            outputs: [{ type: 'bytes' }],
        },
    ],
    factoryAbi: [],
    JustanAccountImplementation: {},
}));

vi.mock('../constants.js', () => ({
    PERMISSIONS_MANAGER_ADDRESS: '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8',
    FACTORY_ADDRESS: '0x0000000000000000000000000000000000factory',
    JAW_PROXY_URL: 'https://proxy.jaw.example',
}));

vi.mock('../errors/errors.js', async () => {
    const actual = await vi.importActual<typeof import('../errors/errors.js')>('../errors/errors.js');
    return actual;
});

vi.mock('./delegation.js', () => ({
    isDelegatedToImplementation: vi.fn(),
}));

vi.mock('./paymaster.js', () => ({
    createPaymasterFunctions: vi.fn(),
}));

vi.mock('../rpc/permissions.js', () => ({
    getPermissionFromRelay: vi.fn(),
    relayPermissionToPermission: vi.fn(),
    encodeExecuteBatchWithPermission: vi.fn(),
}));

vi.mock('../analytics/index.js', () => ({
    notifyReceiptReceived: vi.fn(),
}));

vi.mock('viem', async () => {
    const actual = await vi.importActual<typeof import('viem')>('viem');
    return {
        ...actual,
        createPublicClient: vi.fn().mockReturnValue({}),
        http: vi.fn(),
    };
});

vi.mock('viem/account-abstraction', async (importOriginal) => ({
    ...(await importOriginal<typeof import('viem/account-abstraction')>()),
    createBundlerClient: vi.fn(),
    createPaymasterClient: vi.fn(),
    toWebAuthnAccount: vi.fn(),
}));

import { getBlockNumber, getCode, getLogs, getTransactionReceipt, multicall, readContract } from 'viem/actions';
import { http } from 'viem';
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';
import { toJustanAccount } from './toJustanAccount.js';
import { createPaymasterFunctions } from './paymaster.js';
import { getPermissionFromRelay, encodeExecuteBatchWithPermission } from '../rpc/permissions.js';
import { notifyReceiptReceived } from '../analytics/index.js';
import {
    createSmartAccountForAddress,
    findOwnerIndex,
    getBundlerClient,
    sendCallsWithPermission,
    sendTransaction,
} from './smartAccount.js';

const MOCK_TARGET_ADDRESS = '0x1234567890123456789012345678901234567890' as Address;
const MOCK_PUBLIC_KEY =
    '0x04abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as Hex;
const MOCK_LOCAL_ADDRESS = '0xabcdef0123456789abcdef0123456789abcdef01' as Address;
const MOCK_LOCAL_ADDRESS_PADDED = '0x000000000000000000000000abcdef0123456789abcdef0123456789abcdef01' as Hex;
const MOCK_BUNDLER_CLIENT = { chain: { id: 1 } } as any;
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const MOCK_WEBAUTHN_ACCOUNT = {
    type: 'webAuthn' as const,
    publicKey: MOCK_PUBLIC_KEY,
    sign: vi.fn(),
} as any;
/**
 * Answers reads by function name, so `ownerCount` and `nextOwnerIndex` can
 * disagree the way they do on an account that has removed an owner. Sequential
 * `mockResolvedValueOnce` chains cannot tell the two reads apart.
 */
function mockAccountWithRemovedOwner(owners: (Hex | undefined)[]) {
    vi.mocked(readContract).mockImplementation((async (_client: unknown, params: any) => {
        if (params.functionName === 'nextOwnerIndex') return BigInt(owners.length);
        if (params.functionName === 'ownerCount') return BigInt(owners.filter(Boolean).length);
        if (params.functionName === 'ownerAtIndex') return owners[Number(params.args[0])] ?? '0x';
        throw new Error(`unexpected read: ${params.functionName}`);
    }) as any);
}

const MOCK_LOCAL_ACCOUNT = {
    type: 'local' as const,
    address: MOCK_LOCAL_ADDRESS,
    sign: vi.fn(),
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
    signTypedData: vi.fn(),
} as any;

describe('createSmartAccountForAddress', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws if account is not deployed (getCode returns undefined)', async () => {
        vi.mocked(getCode).mockResolvedValue(undefined);

        await expect(
            createSmartAccountForAddress(MOCK_TARGET_ADDRESS, MOCK_WEBAUTHN_ACCOUNT, MOCK_BUNDLER_CLIENT)
        ).rejects.toThrow(`Account ${MOCK_TARGET_ADDRESS} is not deployed`);
    });

    it('throws if passkey is not an owner (iterates all owners, none match)', async () => {
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract)
            .mockResolvedValueOnce(2n) // nextOwnerIndex
            .mockResolvedValueOnce('0x00000000000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex) // ownerAtIndex(0)
            .mockResolvedValueOnce('0x00000000000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex); // ownerAtIndex(1)

        await expect(
            createSmartAccountForAddress(MOCK_TARGET_ADDRESS, MOCK_WEBAUTHN_ACCOUNT, MOCK_BUNDLER_CLIENT)
        ).rejects.toThrow(`Signer is not an owner on account ${MOCK_TARGET_ADDRESS}`);
    });

    it('creates smart account when passkey is owner at index 0', async () => {
        const mockSmartAccount = { address: MOCK_TARGET_ADDRESS } as any;
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract)
            .mockResolvedValueOnce(1n) // nextOwnerIndex
            .mockResolvedValueOnce(MOCK_PUBLIC_KEY); // ownerAtIndex(0) matches
        vi.mocked(toJustanAccount).mockResolvedValue(mockSmartAccount);

        const result = await createSmartAccountForAddress(
            MOCK_TARGET_ADDRESS,
            MOCK_WEBAUTHN_ACCOUNT,
            MOCK_BUNDLER_CLIENT
        );

        expect(result).toBe(mockSmartAccount);
        expect(toJustanAccount).toHaveBeenCalledWith({
            client: MOCK_BUNDLER_CLIENT,
            owners: [MOCK_WEBAUTHN_ACCOUNT, '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8'],
            ownerIndex: 0,
            address: MOCK_TARGET_ADDRESS,
        });
    });

    it('finds passkey at non-zero owner index', async () => {
        const mockSmartAccount = { address: MOCK_TARGET_ADDRESS } as any;
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract)
            .mockResolvedValueOnce(3n) // nextOwnerIndex
            .mockResolvedValueOnce('0x00000000000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex) // ownerAtIndex(0) - no match
            .mockResolvedValueOnce('0x00000000000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex) // ownerAtIndex(1) - no match
            .mockResolvedValueOnce(MOCK_PUBLIC_KEY); // ownerAtIndex(2) - match!
        vi.mocked(toJustanAccount).mockResolvedValue(mockSmartAccount);

        const result = await createSmartAccountForAddress(
            MOCK_TARGET_ADDRESS,
            MOCK_WEBAUTHN_ACCOUNT,
            MOCK_BUNDLER_CLIENT
        );

        expect(result).toBe(mockSmartAccount);
        expect(toJustanAccount).toHaveBeenCalledWith({
            client: MOCK_BUNDLER_CLIENT,
            owners: [MOCK_WEBAUTHN_ACCOUNT, '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8'],
            ownerIndex: 2,
            address: MOCK_TARGET_ADDRESS,
        });
    });

    it('creates smart account when local account address matches (padded to 32 bytes)', async () => {
        const mockSmartAccount = { address: MOCK_TARGET_ADDRESS } as any;
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract)
            .mockResolvedValueOnce(1n) // nextOwnerIndex
            .mockResolvedValueOnce(MOCK_LOCAL_ADDRESS_PADDED); // ownerAtIndex(0) matches padded address
        vi.mocked(toJustanAccount).mockResolvedValue(mockSmartAccount);

        const result = await createSmartAccountForAddress(MOCK_TARGET_ADDRESS, MOCK_LOCAL_ACCOUNT, MOCK_BUNDLER_CLIENT);

        expect(result).toBe(mockSmartAccount);
        expect(toJustanAccount).toHaveBeenCalledWith({
            client: MOCK_BUNDLER_CLIENT,
            owners: [MOCK_LOCAL_ACCOUNT, '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8'],
            ownerIndex: 0,
            address: MOCK_TARGET_ADDRESS,
        });
    });

    // Regression: the scan used to stop at `ownerCount()`, which the contract
    // derives as `nextOwnerIndex - removedOwnersCount`. Remove one owner from
    // an account of three and the current owner at index 2 sits past the count,
    // so it was never read and the signer was told it owns nothing.
    it('finds an owner sitting past the owner count, after a removal', async () => {
        const mockSmartAccount = { address: MOCK_TARGET_ADDRESS } as any;
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        // Index 0 removed, so ownerCount reads 2 while the owner lives at 2.
        mockAccountWithRemovedOwner([
            undefined,
            '0x00000000000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
            MOCK_PUBLIC_KEY,
        ]);
        vi.mocked(toJustanAccount).mockResolvedValue(mockSmartAccount);

        const result = await createSmartAccountForAddress(
            MOCK_TARGET_ADDRESS,
            MOCK_WEBAUTHN_ACCOUNT,
            MOCK_BUNDLER_CLIENT
        );

        expect(result).toBe(mockSmartAccount);
        expect(readContract).toHaveBeenCalledWith(
            MOCK_BUNDLER_CLIENT,
            expect.objectContaining({ functionName: 'nextOwnerIndex' })
        );
        expect(toJustanAccount).toHaveBeenCalledWith({
            client: MOCK_BUNDLER_CLIENT,
            owners: [MOCK_WEBAUTHN_ACCOUNT, '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8'],
            ownerIndex: 2,
            address: MOCK_TARGET_ADDRESS,
        });
    });

    it('throws if local account is not an owner', async () => {
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract)
            .mockResolvedValueOnce(1n) // nextOwnerIndex
            .mockResolvedValueOnce('0x00000000000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex); // ownerAtIndex(0) - no match

        await expect(
            createSmartAccountForAddress(MOCK_TARGET_ADDRESS, MOCK_LOCAL_ACCOUNT, MOCK_BUNDLER_CLIENT)
        ).rejects.toThrow(`Signer is not an owner on account ${MOCK_TARGET_ADDRESS}`);
    });
});

// The url and the context used to resolve through two independent `||`, so they
// could come from different sources: a caller overriding only the url, on a chain
// configured with a context, sent that context to the other paymaster. Pairing
// this in `Account` alone would not hold — a `context: undefined` passed down
// here fell back to the chain's again.
describe('getBundlerClient — paymaster resolution', () => {
    const CHAIN = {
        id: 1,
        rpcUrl: 'https://rpc.example',
        paymaster: { url: 'https://configured.example', context: { token: '0xUSDC' } },
    } as never;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(createBundlerClient).mockReturnValue({} as never);
        vi.mocked(createPaymasterClient).mockReturnValue({} as never);
    });

    // The context is the 4th argument to createPaymasterFunctions.
    const contextSentToPaymaster = () => vi.mocked(createPaymasterFunctions).mock.calls[0][3];

    it('takes both halves from the chain when no override is given', () => {
        getBundlerClient(CHAIN);

        expect(http).toHaveBeenCalledWith('https://configured.example');
        expect(contextSentToPaymaster()).toEqual({ token: '0xUSDC' });
    });

    it('takes both halves from the override when one is given', () => {
        getBundlerClient(CHAIN, 'https://override.example', { sponsorshipPolicyId: 'sp_1' });

        expect(http).toHaveBeenCalledWith('https://override.example');
        expect(contextSentToPaymaster()).toEqual({ sponsorshipPolicyId: 'sp_1' });
    });

    it('does not carry the chain context to a paymaster named by override', () => {
        getBundlerClient(CHAIN, 'https://override.example');

        expect(http).toHaveBeenCalledWith('https://override.example');
        expect(contextSentToPaymaster()).toBeUndefined();
    });

    // The other half of "the url decides for the pair": a context on its own has
    // no paymaster to belong to, so it is not applied over the configured one.
    // This is the case a caller reaching the SDK directly can still hit, since
    // `resolvePaymaster` upstream never emits a context without a url.
    it('ignores a context override that names no paymaster of its own', () => {
        getBundlerClient(CHAIN, undefined, { sponsorshipPolicyId: 'sp_1' });

        expect(http).toHaveBeenCalledWith('https://configured.example');
        expect(contextSentToPaymaster()).toEqual({ token: '0xUSDC' });
    });

    it('reads an empty url override as no paymaster, not as no override', () => {
        getBundlerClient(CHAIN, '');

        expect(createPaymasterClient).not.toHaveBeenCalled();
    });
});

// The ERC-20 approval is sized over the permission-manager call the caller builds
// with `buildPermissionManagerCall`. That only means anything if the call it sized
// is the one that goes out, rather than one re-encoded here.
describe('sendCallsWithPermission — the sized call is the sent one', () => {
    const CHAIN = { id: 1, rpcUrl: 'https://rpc.example' } as never;
    const PERMISSION_ID = '0xabc123' as Hex;
    const CALLS = [{ to: '0x1234567890123456789012345678901234567890' as Address }];
    const APPROVAL = {
        to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
        value: 0n,
        data: '0xapprove' as Hex,
    };
    const PERMISSION_CALL = {
        to: '0x0000000000000000000000000000000000009999' as Address,
        value: 0n,
        data: '0xbeefbeef' as Hex,
    };

    let sendUserOperation: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        sendUserOperation = vi.fn().mockResolvedValue('0xuserophash');
        vi.mocked(createBundlerClient).mockReturnValue({ sendUserOperation } as never);
        vi.mocked(encodeExecuteBatchWithPermission).mockReturnValue('0xencodedhere' as Hex);
    });

    it('sends the caller-built permission call, without fetching the permission twice', async () => {
        await sendCallsWithPermission(
            {} as never,
            CALLS,
            CHAIN,
            PERMISSION_ID,
            'test-key',
            undefined,
            undefined,
            undefined,
            APPROVAL,
            PERMISSION_CALL
        );

        expect(getPermissionFromRelay).not.toHaveBeenCalled();
        // Approval first, at the spender level: the permission manager checks each
        // call in its batch against the permission and would reject `approve`.
        expect(sendUserOperation.mock.calls[0][0].calls).toEqual([APPROVAL, PERMISSION_CALL]);
    });

    it('builds the permission call itself when the caller passed none', async () => {
        await sendCallsWithPermission({} as never, CALLS, CHAIN, PERMISSION_ID, 'test-key');

        expect(getPermissionFromRelay).toHaveBeenCalledWith(PERMISSION_ID, 'test-key');
        expect(sendUserOperation.mock.calls[0][0].calls).toEqual([
            { to: '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8', value: 0n, data: '0xencodedhere' },
        ]);
    });
});

// A keyless dApp is attributed by the forwarded origin, so its transactions are
// reported like anybody else's. This path is the popup's: keys calls it on Confirm.
describe('sendTransaction — receipt reporting', () => {
    const CHAIN = { id: 1, rpcUrl: 'https://rpc.example' } as never;
    const CALLS = [{ to: MOCK_TARGET_ADDRESS }];
    const TX_HASH = '0xbbb2'.padEnd(66, '0');

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(createBundlerClient).mockReturnValue({
            sendUserOperation: vi.fn().mockResolvedValue('0xuserophash'),
            waitForUserOperationReceipt: vi.fn().mockResolvedValue({
                success: true,
                receipt: { status: 'success', transactionHash: TX_HASH },
            }),
        } as never);
    });

    // Keys builds the account with `preference?.apiKey || ''`, so a keyless dApp
    // arrives as the empty string rather than as undefined.
    it.each(['real-key', undefined, ''])('reports the receipt with apiKey %o', async (apiKey) => {
        await sendTransaction({} as never, CALLS, CHAIN, undefined, undefined, apiKey);

        expect(notifyReceiptReceived).toHaveBeenCalledTimes(1);
        expect(vi.mocked(notifyReceiptReceived).mock.calls[0][0]).toMatchObject({
            userOpHash: '0xuserophash',
            transactionHash: TX_HASH,
            success: true,
            apiKey,
        });
    });

    // A permission grant goes through here and waits for the receipt. Etherspot
    // fails that lookup for EntryPoint v0.8, which failed a grant that had landed.
    it('returns the transaction hash from the chain when the bundler has no receipt', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.mocked(createBundlerClient).mockReturnValue({
            client: {},
            sendUserOperation: vi.fn().mockResolvedValue('0xuserophash'),
            waitForUserOperationReceipt: vi.fn().mockRejectedValue(new Error('Missing/invalid userOpHash')),
        } as never);
        vi.mocked(getBlockNumber).mockResolvedValue(5_000n);
        vi.mocked(getLogs).mockResolvedValue([{ transactionHash: TX_HASH, args: { success: true } }] as never);
        vi.mocked(getTransactionReceipt).mockResolvedValue({ status: 'success', transactionHash: TX_HASH } as never);

        await expect(sendTransaction({} as never, CALLS, CHAIN)).resolves.toBe(TX_HASH);
        expect(vi.mocked(notifyReceiptReceived).mock.calls[0][0]).toMatchObject({ success: true });
    });

    it('fails with the hash when the operation never shows up on chain', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.mocked(createBundlerClient).mockReturnValue({
            client: {},
            sendUserOperation: vi.fn().mockResolvedValue('0xuserophash'),
            waitForUserOperationReceipt: vi.fn().mockRejectedValue(new Error('Missing/invalid userOpHash')),
        } as never);
        vi.mocked(getBlockNumber).mockResolvedValue(5_000n);
        vi.mocked(getLogs).mockResolvedValue([]);

        const sending = expect(sendTransaction({} as never, CALLS, CHAIN)).rejects.toThrow(
            'User operation 0xuserophash was sent but is not on chain yet'
        );
        await vi.runAllTimersAsync();
        await sending;

        expect(notifyReceiptReceived).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});

describe('findOwnerIndex', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 0 for an account with no code, without reading it', async () => {
        vi.mocked(getCode).mockResolvedValue(undefined);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: MOCK_BUNDLER_CLIENT, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(0);
        expect(readContract).not.toHaveBeenCalled();
    });

    // Same regression as above, on the path that picks the index for signing.
    // Falling back to 0 here wraps the signature for a different owner, which
    // the account rejects.
    it('finds an owner sitting past the owner count, after a removal', async () => {
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        mockAccountWithRemovedOwner([
            undefined,
            '0x00000000000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
            MOCK_PUBLIC_KEY,
        ]);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: MOCK_BUNDLER_CLIENT, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(2);
    });

    it('returns 0 when the key owns nothing', async () => {
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract)
            .mockResolvedValueOnce(1n) // nextOwnerIndex
            .mockResolvedValueOnce('0x00000000000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex); // ownerAtIndex(0)

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: MOCK_BUNDLER_CLIENT, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(0);
    });

    // The account is deployed, so the read failing is the RPC failing. Returning
    // 0 here used to look like a safe default and is not: it wraps the signature
    // for whoever holds slot 0, and the account rejects that on chain with a
    // revert that says nothing about the RPC.
    it('surfaces an RPC failure instead of signing as owner 0', async () => {
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract).mockRejectedValueOnce(new Error('rpc down'));

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: MOCK_BUNDLER_CLIENT, publicKey: MOCK_PUBLIC_KEY })
        ).rejects.toThrow('rpc down');
    });

    it('does not read a slot on an account that has never had one', async () => {
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
        vi.mocked(readContract).mockResolvedValueOnce(0n); // nextOwnerIndex

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: MOCK_BUNDLER_CLIENT, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(0);
        expect(readContract).toHaveBeenCalledTimes(1);
        expect(multicall).not.toHaveBeenCalled();
    });
});

/**
 * `nextOwnerIndex` never shrinks, so the scan is as long as the account's whole
 * rotation history. These pin which of the two access patterns runs, because the
 * fallback is what a chain without Multicall3 gets and it has to keep working.
 */
describe('how findOwnerIndex reads the owner slots', () => {
    const withMulticall3 = {
        chain: { id: 1, contracts: { multicall3: { address: MULTICALL3_ADDRESS } } },
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getCode).mockResolvedValue('0x1234' as Hex);
    });

    /** Answers one window at a time, the way the aggregate is actually issued. */
    function mockAggregatedSlots(slots: (Hex | undefined)[]) {
        vi.mocked(readContract).mockResolvedValueOnce(BigInt(slots.length)); // nextOwnerIndex
        vi.mocked(multicall).mockImplementation((async (_client: unknown, params: any) => {
            const first = Number(params.contracts[0].args[0]);
            return params.contracts.map((_: unknown, i: number) => slots[first + i] ?? '0x');
        }) as any);
    }

    it('aggregates the slots instead of reading them one at a time', async () => {
        const slots = Array.from({ length: 200 }, (_, i) => (i === 197 ? MOCK_PUBLIC_KEY : undefined));
        mockAggregatedSlots(slots);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: withMulticall3, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(197);

        // One read for the bound, one aggregate for all 200 slots.
        expect(readContract).toHaveBeenCalledTimes(1);
        expect(multicall).toHaveBeenCalledTimes(1);

        const [, params] = vi.mocked(multicall).mock.calls[0] as [unknown, any];
        expect(params.contracts).toHaveLength(200);
        expect(params.multicallAddress).toBe(MULTICALL3_ADDRESS);
        // viem chunks by calldata size otherwise, which would split this into
        // eleven requests and make the count above meaningless.
        expect(params.batchSize).toBe(0);
    });

    // `nextOwnerIndex` is reported by whatever account we were handed, and
    // `resolveSmartAccount` takes that address off `from`/`options.address`. So
    // the scan has to stay windowed rather than building itself from that number:
    // 50 million slots allocated up front exhausts the heap before a single
    // request goes out.
    it('never builds more than one window, whatever the account reports', async () => {
        const slots = Array.from({ length: 700 }, (_, i) => (i === 690 ? MOCK_PUBLIC_KEY : undefined));
        mockAggregatedSlots(slots);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: withMulticall3, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(690);

        const windows = vi.mocked(multicall).mock.calls.map(([, p]) => (p as any).contracts.length);
        expect(windows).toEqual([256, 256, 188]);
        expect(Math.max(...windows)).toBeLessThanOrEqual(256);
    });

    // The regression this window exists for. A hostile account reports a slot
    // count no real account has; building the scan from it allocated the whole
    // range up front, which exhausted a 4 GB heap at 50 million before any
    // request went out. The window means we allocate 256 and go to the network.
    it('answers from the first window when the account claims fifty million slots', async () => {
        vi.mocked(readContract).mockResolvedValueOnce(50_000_000n); // nextOwnerIndex
        vi.mocked(multicall).mockImplementation((async (_client: unknown, params: any) =>
            params.contracts.map((_: unknown, i: number) => (i === 5 ? MOCK_PUBLIC_KEY : '0x'))) as any);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: withMulticall3, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(5);

        expect(multicall).toHaveBeenCalledTimes(1);
        const [, params] = vi.mocked(multicall).mock.calls[0] as [unknown, any];
        expect(params.contracts).toHaveLength(256);
    });

    it('stops at the window holding the match rather than scanning the rest', async () => {
        const slots = Array.from({ length: 700 }, (_, i) => (i === 3 ? MOCK_PUBLIC_KEY : undefined));
        mockAggregatedSlots(slots);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: withMulticall3, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(3);
        expect(multicall).toHaveBeenCalledTimes(1);
    });

    // `_removeOwnerAtIndex` deletes the mapping entry (MultiOwnable.sol:304), so a
    // removed slot reads back as empty bytes rather than reverting. That is what
    // makes `allowFailure: false` safe on the aggregate.
    it('reads a removed slot back as empty and keeps scanning', async () => {
        mockAggregatedSlots([undefined, undefined, MOCK_PUBLIC_KEY]);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: withMulticall3, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(2);
    });

    it('returns 0 when the aggregate holds no match', async () => {
        mockAggregatedSlots([undefined, undefined]);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: withMulticall3, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(0);
    });

    // getBundlerClient resolves its chain through `SUPPORTED_CHAINS.find(...)`,
    // which is undefined for a chain the SDK does not know, and viem cannot
    // aggregate without the address. The sequential read has to stay.
    // The aggregate twin of this is covered above, and the two derive the index
    // differently: that one offsets a findIndex result, this one offsets a loop
    // counter. Getting it wrong here wraps the signature for a different owner,
    // on exactly the chains that have no Multicall3 to fall back from.
    it('offsets the index by the window on the sequential path too', async () => {
        mockAccountWithRemovedOwner(Array.from({ length: 300 }, (_, i) => (i === 260 ? MOCK_PUBLIC_KEY : undefined)));

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: MOCK_BUNDLER_CLIENT, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(260);
        expect(multicall).not.toHaveBeenCalled();
    });

    it('reads slot by slot when the chain carries no Multicall3 address', async () => {
        mockAccountWithRemovedOwner([undefined, MOCK_PUBLIC_KEY, undefined]);

        await expect(
            findOwnerIndex({ address: MOCK_TARGET_ADDRESS, client: MOCK_BUNDLER_CLIENT, publicKey: MOCK_PUBLIC_KEY })
        ).resolves.toBe(1);

        expect(multicall).not.toHaveBeenCalled();
        // nextOwnerIndex, then slot 0 and slot 1. It stops at the match rather
        // than reading slot 2.
        expect(readContract).toHaveBeenCalledTimes(3);
    });
});
