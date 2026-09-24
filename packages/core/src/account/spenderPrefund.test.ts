import { describe, it, expect } from 'vitest';
import { decodeFunctionData, erc20Abi, type Address } from 'viem';
import { buildSpenderPrefundCall, type PrefundReader } from './spenderPrefund.js';
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

describe('buildSpenderPrefundCall', () => {
    it('transfers an operation of gas, priced in the token the permission names', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            read: reader({ [ACCOUNT]: 5_000_000n }),
        });

        expect(call?.to).toBe(USDC);
        const decoded = decodeFunctionData({ abi: erc20Abi, data: call!.data });
        expect(decoded.functionName).toBe('transfer');
        expect(decoded.args).toEqual([SPENDER, PREFUND]);
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
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: wide,
            read: reader({ [ACCOUNT]: 10n ** 18n }, { exchangeRate: async () => 10n ** 18n }),
        });

        const decoded = decodeFunctionData({ abi: erc20Abi, data: call!.data });
        expect(decoded.args).toEqual([SPENDER, 2_000_000n * GAS_PRICE]);
    });

    // Trimming to the allowance sent all of it to the session address, outside
    // the permission, in the one case where the session could not have run on it
    // anyway.
    it('sends nothing when one operation costs more than the permission allows', async () => {
        const mainnetGas = 30_000_000_000n; // 30 gwei
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend, // 10 USDC per day
            read: reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => mainnetGas }),
        });

        expect((2_000_000n * mainnetGas * RATE) / 10n ** 18n).toBeGreaterThan(10_000_000n);
        expect(call).toBeNull();
    });

    // The boundary belongs to the transfer: an allowance that covers an
    // operation exactly is an allowance that covers it.
    it('sends the transfer when the allowance matches one operation exactly', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: { spends: [{ token: USDC, allowance: String(ONE_OP), unit: 'day' as never }] },
            read: reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI }),
        });

        expect(decodeFunctionData({ abi: erc20Abi, data: call!.data }).args).toEqual([SPENDER, ONE_OP]);
    });

    // The buffer is what the transfer would like, not what the permission has to
    // cover. An allowance between the two funds a session that runs, so trimming
    // to it beats refusing: the alternative here is a session that cannot pay.
    it('trims to the allowance when it covers an operation but not the buffer', async () => {
        const between = 8_000_000n;
        expect(between).toBeGreaterThan(ONE_OP);
        expect(between).toBeLessThan(BUFFERED);

        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: { spends: [{ token: USDC, allowance: String(between), unit: 'day' as never }] },
            read: reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI }),
        });

        expect(decodeFunctionData({ abi: erc20Abi, data: call!.data }).args).toEqual([SPENDER, between]);
    });

    it('leaves the amount alone when the allowance is above it', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            read: reader({ [ACCOUNT]: 5_000_000n }),
        });

        const decoded = decodeFunctionData({ abi: erc20Abi, data: call!.data });
        expect(decoded.args).toEqual([SPENDER, PREFUND]);
    });

    // The contract applies every limit configured for a token, so the effective
    // cap is their intersection: the tightest entry is the one that binds. The
    // ceiling must not depend on which of them the requester wrote first.
    it('takes the tightest allowance when a token carries several periods', async () => {
        const tight = { token: USDC, allowance: '1000000', unit: 'minute' as never };
        const loose = { token: USDC, allowance: '50000000', unit: 'day' as never };
        const read = reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI });
        const callFor = (spends: PermissionsDetail['spends']) =>
            buildSpenderPrefundCall({ account: ACCOUNT, spender: SPENDER, permissions: { spends }, read });

        expect(await callFor([tight, loose])).toBeNull();
        expect(await callFor([loose, tight])).toBeNull();

        // The loose entry on its own clears an operation, which is what makes the
        // two nulls the tight entry's doing rather than the price's.
        const looseOnly = await callFor([loose]);
        expect(decodeFunctionData({ abi: erc20Abi, data: looseOnly!.data }).args).toEqual([SPENDER, BUFFERED]);
    });

    // A `forever` entry never renews, so no window is long enough for a wider
    // periodic one to matter: 5 USDC forever is all this permission authorises,
    // and one operation costs 6. The 50 USDC daily entry beside it would have
    // allowed the transfer.
    it('holds a forever allowance as the ceiling over a wider periodic one', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: {
                spends: [
                    { token: USDC, allowance: '50000000', unit: 'day' as never },
                    { token: USDC, allowance: '5000000', unit: 'forever' as never },
                ],
            },
            read: reader({ [ACCOUNT]: 10n ** 12n }, { gasPrice: async () => TWO_GWEI }),
        });

        expect(call).toBeNull();
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
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: mixed,
            read: reader({ [ACCOUNT]: 5_000_000n }),
        });

        expect(call).toBeNull();
    });

    it('declines rather than guessing when the allowance cannot be read', async () => {
        const unreadable: PermissionsDetail = {
            spends: [{ token: USDC, allowance: 'ten dollars', unit: 'day' as never }],
        };
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: unreadable,
            read: reader({ [ACCOUNT]: 5_000_000n }),
        });

        expect(call).toBeNull();
    });

    it('declines on a zero allowance, which authorises no spend to fund', async () => {
        const zero: PermissionsDetail = {
            spends: [{ token: USDC, allowance: '0', unit: 'day' as never }],
        };
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: zero,
            read: reader({ [ACCOUNT]: 5_000_000n }),
        });

        expect(call).toBeNull();
    });

    // Sending it would leave the spender holding something it cannot pay a fee
    // with, which is the whole of what the prefund is for.
    it('does nothing when the paymaster does not take the token', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            read: reader({ [ACCOUNT]: 5_000_000n }, { exchangeRate: async () => null }),
        });

        expect(call).toBeNull();
    });

    // Picking one ourselves would move funds the permission never mentioned.
    it('does nothing when the permission authorises no ERC-20 spend', async () => {
        for (const permissions of [
            {},
            { spends: [] },
            { spends: [{ token: NATIVE_TOKEN, allowance: '1', unit: 'day' as never }] },
        ] satisfies PermissionsDetail[]) {
            const call = await buildSpenderPrefundCall({
                account: ACCOUNT,
                spender: SPENDER,
                permissions,
                read: reader({ [ACCOUNT]: 5_000_000n }),
            });
            expect(call).toBeNull();
        }
    });

    // Recreating a session with the same key grants to the same spender, which
    // still holds what the last grant sent it.
    it('does nothing when the spender already holds the prefund', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            read: reader({ [ACCOUNT]: 5_000_000n, [SPENDER]: PREFUND }),
        });

        expect(call).toBeNull();
    });

    it('tops the spender back up once it has spent below the prefund', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            read: reader({ [ACCOUNT]: 5_000_000n, [SPENDER]: PREFUND - 1n }),
        });

        expect(call).not.toBeNull();
    });

    it('does nothing when the account cannot cover it', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            read: reader({ [ACCOUNT]: PREFUND - 1n }),
        });

        expect(call).toBeNull();
    });

    // The keys screen estimates gas before this call exists, so an account with
    // exactly enough for the fee would pass there and then fail when the
    // paymaster charges in postOp, taking the whole grant down with it.
    it('leaves the transaction its own fee behind', async () => {
        const args = {
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            paymasterContext: { token: USDC, gas: '50000' },
            read: reader({ [ACCOUNT]: PREFUND + 49_999n }),
        };

        expect(await buildSpenderPrefundCall(args)).toBeNull();
        expect(
            await buildSpenderPrefundCall({ ...args, read: reader({ [ACCOUNT]: PREFUND + 50_000n }) })
        ).not.toBeNull();
    });

    // A paymaster charging in something else takes nothing from the balance the
    // prefund comes out of, so there is nothing to reserve.
    it('reserves nothing when the transaction is paid in another token', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            paymasterContext: { token: '0x9999999999999999999999999999999999999999', gas: '50000' },
            read: reader({ [ACCOUNT]: PREFUND }),
        });

        expect(call).not.toBeNull();
    });

    // The context comes from the grant request, so this number is one the
    // requester wrote. Sending the transfer against a fee we cannot read is how
    // the account ends up short and the grant reverts.
    it('does nothing when the fee in the paymaster context cannot be read', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            paymasterContext: { token: USDC, gas: 'not a number' },
            read: reader({ [ACCOUNT]: 5_000_000n }),
        });

        expect(call).toBeNull();
    });

    // A context naming this token but no `gas` is the path where the approval
    // sizes the ceiling itself. The paymaster still charges, so a fee we cannot
    // see is one we cannot leave behind.
    it('does nothing when the context names this token without a fee', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            paymasterContext: { token: USDC },
            read: reader({ [ACCOUNT]: 5_000_000n }),
        });

        expect(call).toBeNull();
    });

    // The other half of that rule: a context with no `gas` naming some other
    // token is a paymaster charging elsewhere, which takes nothing from the
    // balance the transfer comes out of and leaves nothing to reserve.
    it('still sends when the context names another token without a fee', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: usdcSpend,
            paymasterContext: { token: '0x9999999999999999999999999999999999999999' },
            read: reader({ [ACCOUNT]: PREFUND }),
        });

        expect(call).not.toBeNull();
    });

    // The fee used to be decided against `spends[0]` while the prefund went out
    // in the first non-native one, so a native spend ahead of the token left the
    // fee unreserved and the grant could revert for want of it.
    it('reserves the fee against the token it actually sends, not the first spend', async () => {
        const call = await buildSpenderPrefundCall({
            account: ACCOUNT,
            spender: SPENDER,
            permissions: {
                spends: [
                    { token: NATIVE_TOKEN, allowance: '1', unit: 'day' as never },
                    { token: USDC, allowance: '10000000', unit: 'day' as never },
                ],
            },
            paymasterContext: { token: USDC, gas: '50000' },
            read: reader({ [ACCOUNT]: PREFUND + 49_999n }),
        });

        expect(call).toBeNull();
    });
});
