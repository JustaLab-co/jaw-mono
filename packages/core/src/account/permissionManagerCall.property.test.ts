/**
 * A session send goes out as one call to the permission manager wrapping the
 * caller's calls. The contract checks each wrapped call's target and selector
 * against the permission, so whatever the wrapper drops, reorders or rewrites
 * is a call the contract judged that nobody asked for, or a call someone asked
 * for that the contract never saw.
 *
 * Decoded with an ABI written from the Solidity structs, the same shape
 * vectors/README.md feeds to `cast`, rather than with the local
 * `SPEND_PERMISSIONS_MANAGER_ABI` the encoder uses.
 */
import fc from 'fast-check';
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from 'viem';
import { describe, it, expect } from 'vitest';

import { PERMISSIONS_MANAGER_ADDRESS } from '../constants.js';
import type { Permission, SpendPeriod } from '../rpc/permissions.js';
import { buildPermissionManagerCall } from './smartAccount.js';

fc.configureGlobal({ seed: 0x9e4, numRuns: 200 });

const CONTRACT_ABI = parseAbi([
    'struct CallPermission { address target; bytes4 selector; address checker; }',
    'struct SpendLimit { address token; uint160 allowance; uint8 unit; uint16 multiplier; }',
    'struct Permission { address account; address spender; uint48 start; uint48 end; uint256 salt; CallPermission[] calls; SpendLimit[] spends; }',
    'struct Call { address target; uint256 value; bytes data; }',
    'function executeBatch(Permission permission, Call[] calls)',
]);

/** The contract's PeriodUnit enum, in declared order. */
const PERIOD_UNIT: Record<Exclude<SpendPeriod, 'year'>, number> = {
    minute: 0,
    hour: 1,
    day: 2,
    week: 3,
    month: 4,
    forever: 5,
};

const hexBytes = (min: number, max: number) =>
    fc.uint8Array({ minLength: min, maxLength: max }).map((b) => `0x${Buffer.from(b).toString('hex')}` as Hex);
const address = hexBytes(20, 20).map((h) => h as Address);

const permission: fc.Arbitrary<Permission> = fc.record({
    account: address,
    spender: address,
    start: fc.integer({ min: 0, max: 2 ** 48 - 1 }),
    end: fc.integer({ min: 0, max: 2 ** 48 - 1 }),
    salt: fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }),
    calls: fc.array(fc.record({ target: address, selector: hexBytes(4, 4), checker: address }), { maxLength: 3 }),
    spends: fc.array(
        fc.record({
            token: address,
            allowance: fc.bigInt({ min: 0n, max: 2n ** 160n - 1n }),
            unit: fc.constantFrom<Exclude<SpendPeriod, 'year'>>('minute', 'hour', 'day', 'week', 'month', 'forever'),
            multiplier: fc.integer({ min: 1, max: 65_535 }),
        }),
        { maxLength: 3 }
    ),
});

const calls = fc.array(
    fc.record(
        { to: address, value: fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), data: hexBytes(0, 100) },
        { requiredKeys: ['to'] }
    ),
    { maxLength: 6 }
);

describe('the permission manager call around a session send', () => {
    it('carries every call as given, in order, and the permission unchanged', () => {
        fc.assert(
            fc.property(permission, calls, (p, given) => {
                const built = buildPermissionManagerCall(p, given);

                expect(built.to).toBe(getAddress(PERMISSIONS_MANAGER_ADDRESS));
                expect(built.value).toBe(0n);

                const { functionName, args } = decodeFunctionData({ abi: CONTRACT_ABI, data: built.data });
                expect(functionName).toBe('executeBatch');
                const [sentPermission, sentCalls] = args;

                expect(sentCalls).toEqual(
                    given.map((c) => ({ target: getAddress(c.to), value: c.value ?? 0n, data: c.data ?? '0x' }))
                );
                expect(sentPermission).toEqual({
                    account: getAddress(p.account),
                    spender: getAddress(p.spender),
                    start: p.start,
                    end: p.end,
                    salt: p.salt,
                    calls: p.calls.map((c) => ({
                        target: getAddress(c.target),
                        selector: c.selector,
                        checker: getAddress(c.checker),
                    })),
                    spends: p.spends.map((s) => ({
                        token: getAddress(s.token),
                        allowance: s.allowance,
                        unit: PERIOD_UNIT[s.unit as Exclude<SpendPeriod, 'year'>],
                        multiplier: s.multiplier,
                    })),
                });
            })
        );
    });
});
