/**
 * A call checker is part of the permission hash, so the checker a dApp asks for
 * has to reach the approve calldata, the relay and the response unchanged. Lose
 * it anywhere and the permission the caller holds hashes to one that does not
 * exist on chain.
 *
 * Only the network is mocked: the bundler send, the receipt read and the relay
 * call. The encoder and the event decode are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    zeroAddress,
    type AbiParameter,
    type Address,
    type Hex,
} from 'viem';
import type { SmartAccount } from 'viem/account-abstraction';

vi.mock('../account/smartAccount.js', () => ({
    sendTransaction: vi.fn(),
    getBundlerClient: vi.fn(() => ({})),
}));

vi.mock('viem/actions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('viem/actions')>()),
    getTransactionReceipt: vi.fn(),
}));

vi.mock('../api/index.js', () => ({ restCall: vi.fn() }));

import { sendTransaction } from '../account/smartAccount.js';
import { getTransactionReceipt } from 'viem/actions';
import { restCall } from '../api/index.js';
import { PERMISSIONS_MANAGER_ADDRESS } from '../constants.js';
import type { Chain } from '../store/index.js';
import {
    buildGrantPermissionCall,
    grantPermissions,
    SPEND_PERMISSIONS_MANAGER_ABI,
    type PermissionsDetail,
} from './permissions.js';

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const SPENDER: Address = '0x2222222222222222222222222222222222222222';
const TARGET: Address = '0x3333333333333333333333333333333333333333';
const CHECKER: Address = '0x8888888888888888888888888888888888888888';
const PERMISSION_HASH: Hex = '0xabababababababababababababababababababababababababababababababab';

const smartAccount = { address: ACCOUNT } as SmartAccount;
const chain = { id: 84532 } as Chain;

const [approvedEvent] = SPEND_PERMISSIONS_MANAGER_ABI.filter(
    (item) => item.type === 'event' && item.name === 'PermissionApproved'
);

/** The permission struct the approve call carries, as the contract will read it. */
function approvedPermission() {
    // The approval is the last call handed to the bundler.
    const approve = vi.mocked(sendTransaction).mock.calls.at(-1)?.[1].at(-1);
    if (!approve?.data) throw new Error('no approve call was sent');
    const decoded = decodeFunctionData({ abi: SPEND_PERMISSIONS_MANAGER_ABI, data: approve.data });
    if (decoded.functionName !== 'approve') throw new Error(`expected approve, got ${decoded.functionName}`);
    return decoded.args[0];
}

beforeEach(() => {
    vi.mocked(sendTransaction).mockReset().mockResolvedValue('0xfeed');
    vi.mocked(restCall).mockReset().mockResolvedValue(undefined);
    // The receipt echoes back the permission that was approved, the way the manager emits it.
    vi.mocked(getTransactionReceipt)
        .mockReset()
        .mockImplementation(async () => {
            const nonIndexed = approvedEvent.inputs.filter((input) => !('indexed' in input && input.indexed));
            return {
                logs: [
                    {
                        address: PERMISSIONS_MANAGER_ADDRESS,
                        topics: encodeEventTopics({
                            abi: [approvedEvent],
                            eventName: 'PermissionApproved',
                            args: { permissionHash: PERMISSION_HASH },
                        }),
                        data: encodeAbiParameters(nonIndexed as readonly AbiParameter[], [approvedPermission()]),
                    },
                ],
            } as never;
        });
});

function grant(calls: PermissionsDetail['calls']) {
    return grantPermissions(smartAccount, 2000000000, SPENDER, { calls, spends: [] }, chain, undefined);
}

describe('a call checker on wallet_grantPermissions', () => {
    it('reaches the approve calldata, the relay and the response as the same address', async () => {
        const response = await grant([
            { target: TARGET, functionSignature: 'transfer(address,uint256)', checker: CHECKER },
        ]);

        expect(approvedPermission().calls[0].checker).toBe(CHECKER);
        const relayBody = vi.mocked(restCall).mock.calls[0][2] as { calls: Array<{ checker: Address }> };
        expect(relayBody.calls[0].checker).toBe(CHECKER);
        expect(response.calls[0].checker).toBe(CHECKER);
    });

    it('comes back as the zero address when the dapp asks for none, so the response always rebuilds the hash', async () => {
        const response = await grant([{ target: TARGET, functionSignature: 'transfer(address,uint256)' }]);

        expect(approvedPermission().calls[0].checker).toBe(zeroAddress);
        expect(response.calls[0]).toHaveProperty('checker', zeroAddress);
    });
});

describe('a mixed-case call checker', () => {
    // Accepted like any address a dapp sends, so its checksum must not be what decides the grant.
    it('is encoded even with a bad checksum, as the address it names', () => {
        const badChecksum = '0x398B9D939E7E616E03EA99601C835C920621b2cA' as Address;
        const { data } = buildGrantPermissionCall(ACCOUNT, SPENDER, 2000000000, {
            calls: [{ target: TARGET, functionSignature: 'transfer(address,uint256)', checker: badChecksum }],
        });

        const decoded = decodeFunctionData({ abi: SPEND_PERMISSIONS_MANAGER_ABI, data });
        if (decoded.functionName !== 'approve') throw new Error(`expected approve, got ${decoded.functionName}`);
        expect(decoded.args[0].calls[0].checker.toLowerCase()).toBe(badChecksum.toLowerCase());
    });
});

describe('a malformed call checker', () => {
    // A garbage checker would still hash, to a permission the dapp can never
    // rebuild or revoke, so it is refused before the screen estimates or signs.
    it.each(['0x1234', 'not-an-address', '0x88888888888888888888888888888888888888zz'])(
        'is refused as invalid params before anything is built: %s',
        (checker) => {
            const build = () =>
                buildGrantPermissionCall(ACCOUNT, SPENDER, 2000000000, {
                    calls: [
                        { target: TARGET, functionSignature: 'transfer(address,uint256)', checker: checker as Address },
                    ],
                });

            expect(build).toThrow(
                expect.objectContaining({
                    code: -32602,
                    message: expect.stringContaining('permissions.calls[0].checker'),
                })
            );
        }
    );
});
