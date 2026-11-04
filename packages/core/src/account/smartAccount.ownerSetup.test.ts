/**
 * The owners a send adds before its calls. A 7702 account gets the permissions
 * manager, the recovery manager and its own address; a factory account owned by
 * a local key gets the recovery manager, since its starting owners can't change
 * without moving its address; a passkey account gets nothing, its record holds
 * every owner. The encoders are real; only the chain reads are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SmartAccount } from 'viem/account-abstraction';
import { call, readContract } from 'viem/actions';
import { prepareCallsForExecution } from './smartAccount.js';
import { abi } from './toJustanAccount.js';
import { isDelegatedToImplementation } from './delegation.js';
import { PERMISSIONS_MANAGER_ADDRESS, RECOVERY_MANAGER_ADDRESS } from '../constants.js';
import { buildEnrollRecoveryCall } from '../rpc/recovery.js';
import type { Chain } from '../store/index.js';

vi.mock('viem/actions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('viem/actions')>()),
    call: vi.fn(),
    readContract: vi.fn(),
}));

vi.mock('./delegation.js', () => ({ isDelegatedToImplementation: vi.fn() }));

const KEY = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const FACTORY_ACCOUNT = '0x201bcE6e444BA385F9c79d972D6b8E7dCc58e98c' as Address;
const IMPLEMENTATION = '0xbb4f7d5418Cd8DADB61bb95561179e517572cBCd' as Address;
const AUTHORIZATION = { address: IMPLEMENTATION, chainId: 84532, nonce: 0, r: '0x1', s: '0x2', yParity: 0 };
const CHAIN = { id: 84532, rpcUrl: 'https://rpc.example' } as Chain;
const USER_CALL = { to: getAddress('0x000000000000000000000000000000000000beef'), value: 1n, data: '0x' as Hex };

const PM = getAddress(PERMISSIONS_MANAGER_ADDRESS);
const RM = getAddress(RECOVERY_MANAGER_ADDRESS);
const SELF = getAddress(KEY.address);

/** What the chain says: whether the account has code, and which addresses it owns. */
let chainState: { deployed: boolean; owners: Set<Address> };

function smartAccount(address: Address): SmartAccount {
    return { address, signAuthorization: vi.fn(async () => AUTHORIZATION) } as unknown as SmartAccount;
}

/** The owner each prepended call adds, read back from its calldata. */
function ownersAdded(calls: { to: Address; data: Hex }[], account: Address): Address[] {
    return calls.slice(0, -1).map((c) => {
        expect(c.to).toBe(account);
        const { functionName, args } = decodeFunctionData({ abi, data: c.data });
        expect(functionName).toBe('addOwnerAddress');
        return getAddress(args?.[0] as Address);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    chainState = { deployed: true, owners: new Set() };
    vi.mocked(readContract).mockResolvedValue(IMPLEMENTATION as never);
    vi.mocked(isDelegatedToImplementation).mockResolvedValue(true);
    vi.mocked(call).mockImplementation((async (_client: unknown, { data }: { data: Hex }) => {
        const { functionName, args } = decodeFunctionData({ abi, data });
        expect(functionName).toBe('isOwnerAddress');
        if (!chainState.deployed) return { data: undefined };
        const owned = chainState.owners.has(getAddress(args?.[0] as Address));
        return { data: encodeFunctionResult({ abi, functionName: 'isOwnerAddress', result: owned }) };
    }) as never);
});

describe('an EIP-7702 account', () => {
    const owners = (setup: Partial<Record<'pm' | 'rm' | 'self', boolean>>) =>
        new Set([setup.pm && PM, setup.rm && RM, setup.self && SELF].filter(Boolean) as Address[]);

    it.each([
        [{}, [PM, RM, SELF]],
        [{ pm: true }, [RM, SELF]],
        [{ rm: true }, [PM, SELF]],
        [{ self: true }, [PM, RM]],
        [{ pm: true, rm: true }, [SELF]],
        [{ pm: true, self: true }, [RM]],
        [{ rm: true, self: true }, [PM]],
        [{ pm: true, rm: true, self: true }, []],
    ] as const)('owning %o, gets exactly the missing owners added, in order', async (owned, expected) => {
        chainState.owners = owners(owned);

        const { calls } = await prepareCallsForExecution(smartAccount(KEY.address), [USER_CALL], CHAIN, {
            kind: 'eip7702',
            localAccount: KEY,
        });

        expect(ownersAdded(calls, SELF)).toEqual(expected);
        expect(calls.at(-1)).toEqual(USER_CALL);
    });

    it('adds the recovery manager with the same bytes as the enrol call', async () => {
        chainState.owners = owners({ pm: true, self: true });

        const { calls } = await prepareCallsForExecution(smartAccount(KEY.address), [USER_CALL], CHAIN, {
            kind: 'eip7702',
            localAccount: KEY,
        });

        expect(calls[0].data).toBe(buildEnrollRecoveryCall(SELF).data);
    });

    // A second add of the same owner reverts the whole send.
    it('does not add the recovery manager again when its calls already enrol it', async () => {
        const enrol = { ...buildEnrollRecoveryCall(SELF), value: 0n };

        const { calls } = await prepareCallsForExecution(smartAccount(KEY.address), [enrol], CHAIN, {
            kind: 'eip7702',
            localAccount: KEY,
        });

        expect(ownersAdded(calls, SELF)).toEqual([PM, SELF]);
        expect(calls.at(-1)).toEqual(enrol);
    });

    it('signs the delegation and reads the owners against its code when the EOA is not delegated yet', async () => {
        vi.mocked(isDelegatedToImplementation).mockResolvedValue(false);

        const { calls, authorization } = await prepareCallsForExecution(smartAccount(KEY.address), [USER_CALL], CHAIN, {
            kind: 'eip7702',
            localAccount: KEY,
        });

        expect(authorization).toEqual(AUTHORIZATION);
        expect(ownersAdded(calls, SELF)).toEqual([PM, RM, SELF]);
        for (const [, params] of vi.mocked(call).mock.calls) {
            expect(params.stateOverride).toEqual([
                { address: KEY.address, code: `0xef0100${IMPLEMENTATION.slice(2)}` },
            ]);
        }
    });
});

describe('a factory account owned by a local key', () => {
    it('gets the recovery manager added in the send that deploys it', async () => {
        chainState.deployed = false;

        const { calls, authorization } = await prepareCallsForExecution(
            smartAccount(FACTORY_ACCOUNT),
            [USER_CALL],
            CHAIN,
            { kind: 'localKey' }
        );

        expect(ownersAdded(calls, FACTORY_ACCOUNT)).toEqual([RM]);
        expect(calls[0].data).toBe(buildEnrollRecoveryCall(FACTORY_ACCOUNT).data);
        expect(authorization).toBeUndefined();
    });

    it('gets the recovery manager added when deployed without it', async () => {
        chainState.owners = new Set([PM]);

        const { calls } = await prepareCallsForExecution(smartAccount(FACTORY_ACCOUNT), [USER_CALL], CHAIN, {
            kind: 'localKey',
        });

        expect(ownersAdded(calls, FACTORY_ACCOUNT)).toEqual([RM]);
    });

    it('gets nothing added when its calls already enrol the recovery manager', async () => {
        const enrol = { ...buildEnrollRecoveryCall(FACTORY_ACCOUNT), value: 0n };

        const { calls } = await prepareCallsForExecution(smartAccount(FACTORY_ACCOUNT), [enrol], CHAIN, {
            kind: 'localKey',
        });

        expect(calls).toEqual([enrol]);
    });

    it('gets nothing added once the recovery manager is an owner', async () => {
        chainState.owners = new Set([PM, RM]);

        const { calls } = await prepareCallsForExecution(smartAccount(FACTORY_ACCOUNT), [USER_CALL], CHAIN, {
            kind: 'localKey',
        });

        expect(calls).toEqual([USER_CALL]);
    });
});

describe('a passkey account', () => {
    it('gets nothing added, and nothing is read', async () => {
        const { calls, authorization } = await prepareCallsForExecution(
            smartAccount(FACTORY_ACCOUNT),
            [USER_CALL],
            CHAIN
        );

        expect(calls).toEqual([USER_CALL]);
        expect(authorization).toBeUndefined();
        expect(call).not.toHaveBeenCalled();
    });
});
