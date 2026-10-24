/**
 * Properties of the recovery encoding, checked against what
 * `JustaRecoveryManager` declares.
 *
 * The op payloads reach the manager as opaque bytes it decodes by op type, and
 * the planner's order is what keeps a batch from reverting on a rule the
 * contract enforces mid-way. Neither has a compile-time link to the Solidity,
 * so the assertions are written against it rather than against our own
 * constants, and decoded with an ABI written from the Solidity rather than the
 * local `RECOVERY_MANAGER_ABI` the encoder uses.
 *
 * jaw-recovery/src/interfaces/IRecoveryManager.sol @ 062a5c4
 *
 *     struct AdminOp { uint8 opType; bytes data; }
 *     // ADD_RECOVERY    => abi.encode(address provider, bytes commitment, uint32 delay)
 *     // REMOVE_RECOVERY => abi.encode(bytes32 recoveryId)
 *     // SET_THRESHOLD   => abi.encode(uint256 threshold)
 *     // CANCEL_REQUEST  => abi.encode(bytes32 requestId)
 *
 *     function addRecovery(address account, address provider, bytes commitment, uint32 delay)
 *     function removeRecovery(address account, bytes32 recoveryId)
 *     function setRecoveryThreshold(address account, uint256 threshold)
 *
 * and the rules every op is held to, in order, atomically: a threshold stays
 * within [1, recoveryCount] (InvalidThreshold); a removal may not leave fewer
 * recoveries than the effective threshold, which defaults to 1, except a full
 * opt-out to zero (RemovalBelowThreshold); a recovery is added once
 * (RecoveryAlreadyAdded) and removed only if registered (RecoveryNotRegistered).
 */
import fc from 'fast-check';
import {
    decodeAbiParameters,
    decodeFunctionData,
    getAddress,
    parseAbi,
    parseAbiParameters,
    type Address,
    type Hex,
} from 'viem';
import { describe, it, expect } from 'vitest';

import { RECOVERY_MANAGER_ADDRESS, SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '../constants.js';
import {
    AdminOpType,
    addRecoveryOp,
    buildRecoverySetupCalls,
    cancelRequestOp,
    computeRecoveryId,
    diffRecoveryConfig,
    removeRecoveryOp,
    setThresholdOp,
    toOwnerBytes,
    type AdminOp,
    type RecoveryChainConfig,
    type RecoveryConfig,
    type RecoveryMethod,
} from './recovery.js';

// A fixed seed, so a red build means someone broke something rather than that
// the generator picked differently today.
fc.configureGlobal({ seed: 0x7ec, numRuns: 200 });

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const PROVIDER = SIGNATURE_RECOVERY_PROVIDER_ADDRESS;

const CONTRACT_ABI = parseAbi([
    'function addOwnerAddress(address owner)',
    'function addRecovery(address account, address provider, bytes commitment, uint32 delay) returns (bytes32)',
    'function removeRecovery(address account, bytes32 recoveryId)',
    'function setRecoveryThreshold(address account, uint256 threshold)',
]);
const ADD_DATA = parseAbiParameters('address provider, bytes commitment, uint32 delay');
const ID_DATA = parseAbiParameters('bytes32 id');
const THRESHOLD_DATA = parseAbiParameters('uint256 threshold');

const hexBytes = (min: number, max: number) =>
    fc.uint8Array({ minLength: min, maxLength: max }).map((b) => `0x${Buffer.from(b).toString('hex')}` as Hex);
const address = hexBytes(20, 20).map((h) => h as Address);
const paddedAddress = address.map((a) => `0x${'00'.repeat(12)}${a.slice(2)}` as Hex);
const commitment = fc.oneof(paddedAddress, hexBytes(64, 64));
const bytes32 = hexBytes(32, 32);

describe('the op payloads, as the manager decodes them', () => {
    it('ADD_RECOVERY carries the provider, the commitment and the delay', () => {
        fc.assert(
            fc.property(address, commitment, fc.integer({ min: 0, max: 2 ** 32 - 1 }), (provider, c, delay) => {
                const op = addRecoveryOp({ provider, commitment: c, delay });

                expect(op.opType).toBe(AdminOpType.ADD_RECOVERY);
                const [sentProvider, sentCommitment, sentDelay] = decodeAbiParameters(ADD_DATA, op.data);
                expect(sentProvider).toBe(getAddress(provider));
                expect(sentCommitment).toBe(c);
                expect(sentDelay).toBe(delay);
            })
        );
    });

    it('defaults the provider to the signature provider when the caller omits it', () => {
        fc.assert(
            fc.property(commitment, fc.integer({ min: 0, max: 2 ** 32 - 1 }), (c, delay) => {
                const [sentProvider] = decodeAbiParameters(ADD_DATA, addRecoveryOp({ commitment: c, delay }).data);
                expect(sentProvider).toBe(getAddress(PROVIDER));
            })
        );
    });

    it('refuses a delay the uint32 cannot hold, rather than truncating it', () => {
        // Our input types the delay as a bare number, so nothing before the
        // encoder rejects this. Silently keeping the low 32 bits would register
        // a timelock nobody asked for.
        fc.assert(
            fc.property(fc.integer({ min: 2 ** 32, max: 2 ** 40 }), (delay) => {
                expect(() => addRecoveryOp({ commitment: `0x${'44'.repeat(64)}`, delay })).toThrow(
                    /not in safe 32-bit unsigned integer range/
                );
            })
        );
    });

    it('SET_THRESHOLD carries the threshold as a uint256', () => {
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (threshold) => {
                const op = setThresholdOp(threshold);
                expect(op.opType).toBe(AdminOpType.SET_THRESHOLD);
                expect(decodeAbiParameters(THRESHOLD_DATA, op.data)[0]).toBe(BigInt(threshold));
            })
        );
    });

    it('REMOVE_RECOVERY and CANCEL_REQUEST carry the id alone', () => {
        fc.assert(
            fc.property(bytes32, (id) => {
                const remove = removeRecoveryOp(id);
                const cancel = cancelRequestOp(id);
                expect(remove.opType).toBe(AdminOpType.REMOVE_RECOVERY);
                expect(cancel.opType).toBe(AdminOpType.CANCEL_REQUEST);
                expect(decodeAbiParameters(ID_DATA, remove.data)[0]).toBe(id);
                expect(decodeAbiParameters(ID_DATA, cancel.data)[0]).toBe(id);
            })
        );
    });
});

describe('owner bytes, the MultiOwnable form the manager compares against', () => {
    it('pads an address to 32 bytes with twelve zero bytes in front', () => {
        fc.assert(
            fc.property(address, (a) => {
                expect(toOwnerBytes(a).toLowerCase()).toBe(`0x${'00'.repeat(12)}${a.slice(2)}`.toLowerCase());
            })
        );
    });

    it('leaves a 64-byte public key as it is', () => {
        fc.assert(
            fc.property(hexBytes(64, 64), (key) => {
                expect(toOwnerBytes(key)).toBe(key);
            })
        );
    });

    it('refuses any other length with -32602', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 100 }).filter((n) => n !== 20 && n !== 64),
                (length) => {
                    const bytes = `0x${'ab'.repeat(length)}` as Hex;
                    expect(() => toOwnerBytes(bytes)).toThrow(/20-byte address or a 64-byte public key/);
                    try {
                        toOwnerBytes(bytes);
                    } catch (err) {
                        expect((err as { code?: number }).code).toBe(-32602);
                    }
                }
            )
        );
    });
});

/**
 * The manager's state for one account and the rules it holds each op to. An
 * op the contract would revert throws here, so a batch the planner orders
 * wrongly fails the property instead of landing a partial config on chain.
 */
type Manager = { registered: Map<string, RecoveryMethod>; threshold: number };

const key = (provider: Address, c: Hex) => `${provider.toLowerCase()}:${c.toLowerCase()}`;

function apply(manager: Manager, op: AdminOp): void {
    const count = manager.registered.size;
    switch (op.opType) {
        case AdminOpType.ADD_RECOVERY: {
            const [provider, c, delay] = decodeAbiParameters(ADD_DATA, op.data);
            if (manager.registered.has(key(provider, c))) throw new Error('RecoveryAlreadyAdded');
            manager.registered.set(key(provider, c), {
                recoveryId: computeRecoveryId(ACCOUNT, provider, c),
                provider,
                commitment: c,
                delay,
            });
            return;
        }
        case AdminOpType.REMOVE_RECOVERY: {
            const [id] = decodeAbiParameters(ID_DATA, op.data);
            const entry = [...manager.registered.entries()].find(([, m]) => m.recoveryId === id);
            if (!entry) throw new Error('RecoveryNotRegistered');
            const effective = manager.threshold === 0 ? 1 : manager.threshold;
            if (count - 1 !== 0 && count - 1 < effective) throw new Error('RemovalBelowThreshold');
            manager.registered.delete(entry[0]);
            return;
        }
        case AdminOpType.SET_THRESHOLD: {
            const [threshold] = decodeAbiParameters(THRESHOLD_DATA, op.data);
            if (threshold < 1n || threshold > BigInt(count)) throw new Error('InvalidThreshold');
            manager.threshold = Number(threshold);
            return;
        }
        default:
            throw new Error('a config batch carries no cancel');
    }
}

/** Five commitments to draw from, so current and desired overlap often. */
const POOL = ['aa', 'bb', 'cc', 'dd', 'ee'].map((b) => `0x${'00'.repeat(12)}${b.repeat(20)}` as Hex);

const methods = fc.uniqueArray(
    fc.record({ commitment: fc.constantFrom(...POOL), delay: fc.constantFrom(60, 3_600, 86_400) }),
    { selector: (m) => m.commitment, maxLength: 4 }
);

const current: fc.Arbitrary<RecoveryChainConfig> = methods.chain((ms) =>
    fc.record({
        chainId: fc.constant(84_532),
        deployed: fc.constant(true),
        enrolled: fc.boolean(),
        // A stored zero is "never set"; the contract then treats it as 1.
        threshold: ms.length === 0 ? fc.constant(0) : fc.integer({ min: 1, max: ms.length }),
        recoveries: fc.constant(
            ms.map((m) => ({
                ...m,
                provider: PROVIDER,
                recoveryId: computeRecoveryId(ACCOUNT, PROVIDER, m.commitment),
            }))
        ),
    })
);

const desired: fc.Arbitrary<RecoveryConfig> = methods
    .filter((ms) => ms.length > 0)
    .chain((ms) => fc.record({ recoveries: fc.constant(ms), threshold: fc.integer({ min: 1, max: ms.length }) }));

function asManager(config: RecoveryChainConfig): Manager {
    return {
        registered: new Map(config.recoveries.map((m) => [key(m.provider, m.commitment), m])),
        threshold: config.threshold,
    };
}

describe('the batch that takes the on-chain config to the desired one', () => {
    it('lands on the manager in the order it is signed, and ends in the desired config', () => {
        fc.assert(
            fc.property(current, desired, (from, to) => {
                const manager = asManager(from);

                for (const op of diffRecoveryConfig(from, to)) apply(manager, op);

                const landed = [...manager.registered.values()]
                    .map(({ commitment: c, delay }) => ({ commitment: c, delay }))
                    .sort((a, b) => a.commitment.localeCompare(b.commitment));
                const wanted = [...to.recoveries].sort((a, b) => a.commitment.localeCompare(b.commitment));
                expect(landed).toEqual(wanted);
                expect(manager.threshold).toBe(to.threshold);
            })
        );
    });

    it('is empty when the chain already holds the desired config', () => {
        fc.assert(
            fc.property(
                current.filter((c) => c.recoveries.length > 0),
                (from) => {
                    const same: RecoveryConfig = {
                        recoveries: from.recoveries.map(({ commitment: c, delay }) => ({ commitment: c, delay })),
                        threshold: from.threshold,
                    };
                    expect(diffRecoveryConfig(from, same)).toEqual([]);
                }
            )
        );
    });
});

type Step =
    | { kind: 'enroll'; owner: Address }
    | { kind: 'add'; provider: Address; commitment: Hex; delay: number }
    | { kind: 'remove'; id: Hex }
    | { kind: 'threshold'; threshold: number };

function describeOp(op: AdminOp): Step {
    switch (op.opType) {
        case AdminOpType.ADD_RECOVERY: {
            const [provider, c, delay] = decodeAbiParameters(ADD_DATA, op.data);
            return { kind: 'add', provider, commitment: c, delay };
        }
        case AdminOpType.REMOVE_RECOVERY:
            return { kind: 'remove', id: decodeAbiParameters(ID_DATA, op.data)[0] };
        case AdminOpType.SET_THRESHOLD:
            return { kind: 'threshold', threshold: Number(decodeAbiParameters(THRESHOLD_DATA, op.data)[0]) };
        default:
            throw new Error(`unexpected op ${op.opType}`);
    }
}

function describeCall(call: { to: Address; data: Hex }): Step & { to: Address } {
    const { functionName, args } = decodeFunctionData({ abi: CONTRACT_ABI, data: call.data });
    const to = getAddress(call.to);
    switch (functionName) {
        case 'addOwnerAddress':
            return { kind: 'enroll', owner: args[0], to };
        case 'addRecovery':
            expect(args[0]).toBe(getAddress(ACCOUNT));
            return { kind: 'add', provider: args[1], commitment: args[2], delay: args[3], to };
        case 'removeRecovery':
            expect(args[0]).toBe(getAddress(ACCOUNT));
            return { kind: 'remove', id: args[1], to };
        case 'setRecoveryThreshold':
            expect(args[0]).toBe(getAddress(ACCOUNT));
            return { kind: 'threshold', threshold: Number(args[1]), to };
    }
}

describe('the account door, next to the admin batch', () => {
    it('carries the same changes in the same order, enrolment first when the manager is not an owner yet', () => {
        fc.assert(
            fc.property(current, desired, (from, wanted) => {
                const manager = getAddress(RECOVERY_MANAGER_ADDRESS);
                const enrolment: Array<Step & { to: Address }> = from.enrolled
                    ? []
                    : [{ kind: 'enroll', owner: manager, to: getAddress(ACCOUNT) }];

                expect(buildRecoverySetupCalls(ACCOUNT, from, wanted).map(describeCall)).toEqual([
                    ...enrolment,
                    ...diffRecoveryConfig(from, wanted).map((op) => ({ ...describeOp(op), to: manager })),
                ]);
            })
        );
    });

    it('reads a chain the backend lists nothing for as unenrolled with nothing registered', () => {
        fc.assert(
            fc.property(desired, (to) => {
                const empty: RecoveryChainConfig = {
                    chainId: 84_532,
                    deployed: false,
                    enrolled: false,
                    threshold: 0,
                    recoveries: [],
                };
                expect(buildRecoverySetupCalls(ACCOUNT, undefined, to)).toEqual(
                    buildRecoverySetupCalls(ACCOUNT, empty, to)
                );
            })
        );
    });
});
