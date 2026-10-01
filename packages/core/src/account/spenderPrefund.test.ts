import { describe, it, expect } from 'vitest';
import { decodeFunctionData, erc20Abi, type Address } from 'viem';
import {
    checkSpenderPrefund,
    quoteSpenderPrefund,
    spenderPrefundCall,
    type PrefundReader,
    type SpenderPrefund,
} from './spenderPrefund.js';
import { NATIVE_TOKEN, type PermissionsDetail } from '../rpc/permissions.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const SPENDER = '0x2222222222222222222222222222222222222222' as Address;

/**
 * A Base-ish gas price at 0.001 gwei and the paymaster's rate for a 6-decimal
 * stable with ether around three thousand. `PREFUND_GAS` at those comes to
 * 0.006 USDC, which is the order the measured first operation cost.
 */
const GAS_PRICE = 1_000_000n;
const RATE = 3_000_000_000n;
const PREFUND = 6_000n;

/**
 * At this gas price one operation costs 6 USDC and the buffered transfer 12, so
 * an allowance can sit under the first (refused), between them (trimmed), or
 * above both (sent whole). The ceiling tests pick one of the three.
 */
const TWO_GWEI = 2_000_000_000n;
const ONE_OP = 6_000_000n;
const BUFFERED = 12_000_000n;

const usdcSpend: PermissionsDetail = {
    spends: [{ token: USDC, allowance: '10000000', unit: 'day' as never }],
};

function reader(balances: Partial<Record<Address, bigint>>, overrides: Partial<PrefundReader> = {}): PrefundReader {
    return {
        balanceOf: async (_token, owner) => balances[owner] ?? 0n,
        gasPrice: async () => GAS_PRICE,
        exchangeRate: async () => RATE,
        ...overrides,
    };
}

describe('quoteSpenderPrefund', () => {
    const quote = (permissions: PermissionsDetail, read: PrefundReader) =>
        quoteSpenderPrefund({ account: ACCOUNT, spender: SPENDER, permissions, read });

    it('sizes a transfer of an operation of gas, priced in the token the permission names', async () => {
        expect(await quote(usdcSpend, reader({ [ACCOUNT]: 5_000_000n }))).toEqual({
            kind: 'transfer',
            token: USDC,
            spender: SPENDER,
            amount: PREFUND,
        });
    });

    // The amount used to be a tenth of a token whatever the token was, which is
    // $0.10 in USDC and three hundred in WETH. It comes off the rate now, so the
    // token's decimals no longer decide it.
    it('takes the amount from the rate rather than from the token', async () => {
        // A permission wide enough that its allowance is not what decides the
        // amount here: the point of this one is the rate.
        const wide: PermissionsDetail = {
            spends: [{ token: USDC, allowance: (10n ** 30n).toString(), unit: 'day' as never }],
        };
        const result = await quote(wide, reader({ [ACCOUNT]: 10n ** 18n }, { exchangeRate: async () => 10n ** 18n }));

        expect(result).toMatchObject({ kind: 'transfer', amount: 2_000_000n * GAS_PRICE });
    });

    // Trimming to the allowance sent all of it to the session address, outside
    // the permission, in the one case where the session could not have run on it
    // anyway. Said rather than silent: it is the decline a person can act on.
    it('names the decline when one operation costs more than the permission allows', async () => {
        const mainnetGas = 30_000_000_000n; // 30 gwei
        const result = await quote(
            usdcSpend, // 10 USDC per day
            reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => mainnetGas })
        );

        expect(result).toEqual({
            kind: 'below-one-operation',
            token: USDC,
            allowance: 10_000_000n,
            operationCost: (1_000_000n * mainnetGas * RATE) / 10n ** 18n,
        });
    });

    // The boundary belongs to the transfer: an allowance that covers an
    // operation exactly is an allowance that covers it.
    it('sizes the transfer when the allowance matches one operation exactly', async () => {
        const result = await quote(
            { spends: [{ token: USDC, allowance: String(ONE_OP), unit: 'day' as never }] },
            reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI })
        );

        expect(result).toMatchObject({ kind: 'transfer', amount: ONE_OP });
    });

    // The buffer is what the transfer would like, not what the permission has to
    // cover. An allowance between the two funds a session that runs, so trimming
    // to it beats refusing: the alternative here is a session that cannot pay.
    it('trims to the allowance when it covers an operation but not the buffer', async () => {
        const between = 8_000_000n;
        expect(between).toBeGreaterThan(ONE_OP);
        expect(between).toBeLessThan(BUFFERED);

        const result = await quote(
            { spends: [{ token: USDC, allowance: String(between), unit: 'day' as never }] },
            reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI })
        );

        expect(result).toMatchObject({ kind: 'transfer', amount: between });
    });

    // The contract applies every limit configured for a token, so the effective
    // cap is their intersection: the tightest entry is the one that binds. The
    // ceiling must not depend on which of them the requester wrote first.
    it('takes the tightest allowance when a token carries several periods', async () => {
        const tight = { token: USDC, allowance: '1000000', unit: 'minute' as never };
        const loose = { token: USDC, allowance: '50000000', unit: 'day' as never };
        const read = reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI });

        expect(await quote({ spends: [tight, loose] }, read)).toMatchObject({ kind: 'below-one-operation' });
        expect(await quote({ spends: [loose, tight] }, read)).toMatchObject({ kind: 'below-one-operation' });

        // The loose entry on its own clears an operation, which is what makes the
        // two declines the tight entry's doing rather than the price's.
        expect(await quote({ spends: [loose] }, read)).toMatchObject({ kind: 'transfer', amount: BUFFERED });
    });

    // A `forever` entry never renews, so no window is long enough for a wider
    // periodic one to matter: 5 USDC forever is all this permission authorises,
    // and one operation costs 6. The 50 USDC daily entry beside it would have
    // allowed the transfer.
    it('holds a forever allowance as the ceiling over a wider periodic one', async () => {
        const result = await quote(
            {
                spends: [
                    { token: USDC, allowance: '50000000', unit: 'day' as never },
                    { token: USDC, allowance: '5000000', unit: 'forever' as never },
                ],
            },
            reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI })
        );

        expect(result).toMatchObject({ kind: 'below-one-operation', allowance: 5_000_000n });
    });

    // Skipping only the unreadable entry would widen the ceiling to whatever the
    // readable ones happen to say, which is the opposite of declining.
    it('declines when any allowance for the token cannot be read', async () => {
        const mixed: PermissionsDetail = {
            spends: [
                { token: USDC, allowance: '10000000', unit: 'day' as never },
                { token: USDC, allowance: 'whatever', unit: 'minute' as never },
            ],
        };

        expect(await quote(mixed, reader({ [ACCOUNT]: 5_000_000n }))).toBeNull();
    });

    it('declines rather than guessing when the allowance cannot be read', async () => {
        const unreadable: PermissionsDetail = {
            spends: [{ token: USDC, allowance: 'ten dollars', unit: 'day' as never }],
        };

        expect(await quote(unreadable, reader({ [ACCOUNT]: 5_000_000n }))).toBeNull();
    });

    it('declines on a zero allowance, which authorises no spend to fund', async () => {
        const zero: PermissionsDetail = {
            spends: [{ token: USDC, allowance: '0', unit: 'day' as never }],
        };

        expect(await quote(zero, reader({ [ACCOUNT]: 5_000_000n }))).toBeNull();
    });

    // Sending it would leave the spender holding something it cannot pay a fee
    // with, which is the whole of what the prefund is for.
    it('does nothing when the paymaster does not take the token', async () => {
        expect(
            await quote(usdcSpend, reader({ [ACCOUNT]: 5_000_000n }, { exchangeRate: async () => null }))
        ).toBeNull();
    });

    // Picking one ourselves would move funds the permission never mentioned.
    it('does nothing when the permission authorises no ERC-20 spend', async () => {
        for (const permissions of [
            {},
            { spends: [] },
            { spends: [{ token: NATIVE_TOKEN, allowance: '1', unit: 'day' as never }] },
        ] satisfies PermissionsDetail[]) {
            expect(await quote(permissions, reader({ [ACCOUNT]: 5_000_000n }))).toBeNull();
        }
    });

    // Recreating a session with the same key grants to the same spender, which
    // still holds what the last grant sent it.
    it('does nothing when the spender already holds the prefund', async () => {
        expect(await quote(usdcSpend, reader({ [ACCOUNT]: 5_000_000n, [SPENDER]: PREFUND }))).toBeNull();
    });

    it('tops the spender back up once it has spent below the prefund', async () => {
        expect(await quote(usdcSpend, reader({ [ACCOUNT]: 5_000_000n, [SPENDER]: PREFUND - 1n }))).toMatchObject({
            kind: 'transfer',
        });
    });

    it('does nothing when the account cannot cover it', async () => {
        expect(await quote(usdcSpend, reader({ [ACCOUNT]: PREFUND - 1n }))).toBeNull();
    });
});

describe('checkSpenderPrefund', () => {
    const prefund: SpenderPrefund = { token: USDC, spender: SPENDER, amount: PREFUND };
    const check = (overrides: Partial<Parameters<typeof checkSpenderPrefund>[0]> = {}) =>
        checkSpenderPrefund({
            prefund,
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            read: reader({ [ACCOUNT]: 5_000_000n }),
            ...overrides,
        });

    it('sends exactly the quoted transfer', async () => {
        const call = await check();

        expect(call).toEqual(spenderPrefundCall(prefund));
        expect(call.to).toBe(USDC);
        expect(call.value).toBe(0n);
        const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
        expect(decoded.functionName).toBe('transfer');
        expect(decoded.args).toEqual([SPENDER, PREFUND]);
    });

    // The quote reaches the grant through the caller, so it is held to the
    // rules it was built under rather than trusted.
    it('refuses a prefund addressed to anyone but the spender being approved', async () => {
        await expect(
            check({ prefund: { ...prefund, spender: '0x3333333333333333333333333333333333333333' } })
        ).rejects.toThrow(/not to the spender being approved/);
    });

    it('matches the spender however it is cased', async () => {
        await expect(check({ spender: SPENDER.toUpperCase().replace('0X', '0x') as Address })).resolves.toBeDefined();
    });

    it('refuses a prefund in a token the permission does not spend', async () => {
        await expect(
            check({ prefund: { ...prefund, token: '0x9999999999999999999999999999999999999999' } })
        ).rejects.toThrow(/not the token this permission spends/);
    });

    it('refuses a prefund larger than the tightest allowance', async () => {
        await expect(check({ prefund: { ...prefund, amount: 10_000_001n } })).rejects.toThrow(
            /larger than the permission allows/
        );
        await expect(
            check({ prefund: { ...prefund, amount: 10_000_000n }, read: reader({ [ACCOUNT]: 10_000_000n }) })
        ).resolves.toBeDefined();
    });

    it('refuses an empty prefund', async () => {
        await expect(check({ prefund: { ...prefund, amount: 0n } })).rejects.toThrow();
    });

    // Sent less than the screen showed, the session is short; sent anyway, the
    // grant reverts in postOp after the user signed. Failing here is the only
    // outcome where both what they saw and what happened agree.
    it('fails, before anything is sent, when the account no longer holds it', async () => {
        await expect(check({ read: reader({ [ACCOUNT]: PREFUND - 1n }) })).rejects.toThrow(/Nothing was sent/);
    });

    // An account with exactly enough for the transfer would pass and then fail
    // when the paymaster charges in postOp, taking the whole grant down with it.
    it('leaves the transaction its own fee behind', async () => {
        const paymasterContext = { token: USDC, gas: '50000' };

        await expect(check({ paymasterContext, read: reader({ [ACCOUNT]: PREFUND + 49_999n }) })).rejects.toThrow(
            /with the fee on top/
        );
        await expect(
            check({ paymasterContext, read: reader({ [ACCOUNT]: PREFUND + 50_000n }) })
        ).resolves.toBeDefined();
    });

    // A paymaster charging in something else takes nothing from the balance the
    // prefund comes out of, so there is nothing to reserve.
    it('reserves nothing when the transaction is paid in another token', async () => {
        await expect(
            check({
                paymasterContext: { token: '0x9999999999999999999999999999999999999999', gas: '50000' },
                read: reader({ [ACCOUNT]: PREFUND }),
            })
        ).resolves.toBeDefined();
    });

    // The context comes from the grant request, so this number is one the
    // requester wrote. Sending the transfer against a fee we cannot read is how
    // the account ends up short and the grant reverts.
    it('fails when the fee in the paymaster context cannot be read', async () => {
        await expect(check({ paymasterContext: { token: USDC, gas: 'not a number' } })).rejects.toThrow(
            /Could not size the fee/
        );
    });

    // A context naming this token but no `gas` is the path where the approval
    // sizes the ceiling itself. The paymaster still charges, so a fee we cannot
    // see is one we cannot leave behind.
    it('fails when the context names this token without a fee', async () => {
        await expect(check({ paymasterContext: { token: USDC } })).rejects.toThrow(/Could not size the fee/);
    });

    // The other half of that rule: a context with no `gas` naming some other
    // token is a paymaster charging elsewhere, which leaves nothing to reserve.
    it('still sends when the context names another token without a fee', async () => {
        await expect(
            check({
                paymasterContext: { token: '0x9999999999999999999999999999999999999999' },
                read: reader({ [ACCOUNT]: PREFUND }),
            })
        ).resolves.toBeDefined();
    });

    // The fee used to be decided against `spends[0]` while the prefund went out
    // in the first non-native one, so a native spend ahead of the token left the
    // fee unreserved and the grant could revert for want of it.
    it('reserves the fee against the token it actually sends, not the first spend', async () => {
        await expect(
            check({
                permissions: {
                    spends: [
                        { token: NATIVE_TOKEN, allowance: '1', unit: 'day' as never },
                        { token: USDC, allowance: '10000000', unit: 'day' as never },
                    ],
                },
                paymasterContext: { token: USDC, gas: '50000' },
                read: reader({ [ACCOUNT]: PREFUND + 49_999n }),
            })
        ).rejects.toThrow(/with the fee on top/);
    });
});
