import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { NATIVE_TOKEN } from '../rpc/permissions.js';
import type { PermissionsDetail } from '../rpc/permissions.js';

/**
 * The spender of a permission sends every userOp that permission authorises, and
 * the ERC-20 paymaster charges the sender. Nothing funds the spender before its
 * first op, so without help that op has no fee source and has to be sponsored.
 *
 * The grant is the one transaction the account owner already signs, so it is
 * where the spender gets what it needs. This builds the transfer that rides
 * along in it.
 *
 * The destination is always the spender being approved and the token is always
 * one the permission itself authorises spending, neither of them anything a
 * caller supplies: the grant screen must not become a place a dapp can ask to
 * move funds.
 */

/**
 * What a session's first operation takes, which is the most expensive one it
 * sends: it carries the EIP-7702 authorization and bootstraps the permission
 * manager as a co-owner. Under a million of gas in limits, and measured at
 * 0.0094 USDC on Base Sepolia, the figure `cli/x402/gas-reserve.ts` also holds.
 *
 * Gas rather than an amount of token, because a tenth of a token is $0.10 in
 * USDC and three hundred in WETH and the permission's spend token is whatever
 * the requester wrote. The paymaster's exchange rate turns this into that token.
 *
 * This is the bar the permission has to clear. Below it there is nothing a
 * transfer can do for the session.
 */
const FIRST_OP_GAS = 1_000_000n;

/**
 * What the prefund sends when the permission leaves room for it: an operation
 * plus as much again. The buffer covers the market moving between this grant and
 * that op, and covers the paymaster charging at `maxFeePerGas` while this prices
 * at the current one.
 *
 * Kept apart from `FIRST_OP_GAS` because the two answer different questions, and
 * conflating them is how the buffer ended up deciding whether a session got
 * seeded at all. What this costs is what the transfer would like to be. What an
 * operation costs is what the permission has to cover.
 */
const PREFUND_GAS = 2n * FIRST_OP_GAS;

/**
 * The ceiling on what the prefund may move, and the reason it is the
 * permission's own allowance rather than a number.
 *
 * `PREFUND_GAS` prices in gas, which is what the fee is denominated in, and that
 * is right until gas is expensive. The same multiplier is a fraction of a cent
 * on Base and tens of dollars on mainnet, and all of it lands on the session
 * address, outside the permission, where nothing meters it any more.
 *
 * A fixed cap in the token cannot be written down once: a tenth is $0.10 in
 * USDC and three hundred in WETH, which is the reason the amount is priced in
 * gas to begin with. A cap in native value has the same problem across chains,
 * since a unit of ETH and a unit of POL are not the same money.
 *
 * The permission already carries a number in the right token: what it lets the
 * session spend in a period. Sending more than that to the spender funds it past
 * anything it could do with the authority it was given, so that is the ceiling.
 * It needs no table, it moves when the grant moves, and it is a figure the user
 * approved on the same screen.
 *
 * A permission may carry several periods for one token, and the contract applies
 * every one of them, so the effective cap is their intersection: the tightest
 * entry is the one that binds, and it is the number the chain actually enforces.
 * A `forever` entry never renews, so there is no window long enough for a wider
 * one to matter. Taking the minimum keeps the result independent of the order
 * the requester happened to write them in.
 *
 * A permission too tight to cover one operation is refused outright by the
 * caller rather than trimmed to, which is what used to move all of it.
 */
function ceilingFor(permissions: PermissionsDetail, token: Address): bigint | null {
    let tightest: bigint | null = null;
    for (const spend of permissions.spends ?? []) {
        if (!isSameToken(spend.token, token)) continue;
        try {
            const allowance = BigInt(spend.allowance);
            if (tightest === null || allowance < tightest) tightest = allowance;
        } catch {
            // The allowance reaches here from the grant request, so it is a
            // number the requester wrote. Null like every other unreadable input
            // in this module: a ceiling we cannot size is one we cannot hold to,
            // and skipping just the unreadable entry would silently widen the
            // ceiling to whatever the readable ones say.
            return null;
        }
    }
    return tightest !== null && tightest > 0n ? tightest : null;
}

/** Opt-in for the grant. Off by default: a wallet does not move funds unasked. */
export interface GrantPermissionsOptions {
    /**
     * Include a small transfer to the spender in the grant transaction, so its
     * first userOp can pay its own fee instead of needing a sponsor.
     */
    prefundSpender?: boolean;
}

/** Reads this needs, injected so the caller owns the client and the caching. */
export interface PrefundReader {
    balanceOf(token: Address, owner: Address): Promise<bigint>;
    /** Price per gas on this chain right now, in wei. */
    gasPrice(): Promise<bigint>;
    /**
     * The paymaster's rate for this token, wei to its smallest unit, or null
     * when the paymaster does not take it. Null is also an answer: a token the
     * paymaster will not accept cannot pay the spender's fee, so sending it
     * would not do what the prefund is for.
     */
    exchangeRate(token: Address): Promise<bigint | null>;
}

export interface PrefundArgs {
    /** The account granting the permission, which the transfer comes out of. */
    account: Address;
    /** The address being approved as spender, and the only possible destination. */
    spender: Address;
    permissions: PermissionsDetail;
    /**
     * The paymaster context for this transaction. When it names the same token
     * the prefund goes out in, its `gas` is what the paymaster will take from
     * `account`, and the prefund has to leave that behind: an account with
     * exactly enough for the fee would pass the keys screen's estimate, which
     * runs before this call exists, and then fail when the paymaster charges in
     * postOp, reverting the whole grant.
     */
    paymasterContext?: Record<string, unknown>;
    read: PrefundReader;
}

/**
 * The transfer that funds the spender's first operation, or null when it is not
 * needed, not affordable, or larger than the permission allows.
 *
 * Null rather than a throw for every one of those: the grant is what the user
 * came to do, and none of these are reasons to fail it.
 */
export async function buildSpenderPrefundCall(
    args: PrefundArgs
): Promise<{ to: Address; value: bigint; data: Hex } | null> {
    const token = firstErc20Spend(args.permissions);
    // A permission that authorises no ERC-20 spend has no token to prefund in,
    // and picking one ourselves would move funds the permission never mentioned.
    if (!token) return null;

    const ceiling = ceilingFor(args.permissions, token);
    if (ceiling === null) return null;

    // `exchangeRate` is wei to the token's smallest unit, which is what turns
    // an amount of gas into an amount of this token on this chain right now.
    const exchangeRate = await args.read.exchangeRate(token);
    if (exchangeRate === null) return null;
    const gasPrice = await args.read.gasPrice();
    // Multiplied before dividing, every time: the rate is wei to the token's
    // smallest unit, so a per-gas price rounds to zero on a cheap chain.
    const priceOf = (gas: bigint) => (gas * gasPrice * exchangeRate) / 10n ** 18n;

    // A permission that cannot cover one operation is one no transfer can fix:
    // the spender would hold the whole allowance, outside the permission where
    // nothing meters it, and still not land an op. Refused rather than trimmed
    // to the allowance, which is what sent all of it.
    if (priceOf(FIRST_OP_GAS) > ceiling) {
        // The one decline of these that a person can act on, by granting more.
        // Silent, it reaches them as a session that cannot pay for anything.
        console.warn(
            `Permission allows ${ceiling} of ${token} per period, under the ${priceOf(FIRST_OP_GAS)} ` +
                'one operation costs here, so the spender was not funded.'
        );
        return null;
    }

    // It can cover an operation, so ask for the buffer and settle for the
    // allowance. Trimming here funds a session that runs.
    const priced = priceOf(PREFUND_GAS);
    const amount = priced < ceiling ? priced : ceiling;
    if (amount === 0n) return null;

    // Re-granting to the same spender, which the CLI does whenever a session is
    // recreated with the same key. It still holds the last one.
    const spenderBalance = await args.read.balanceOf(token, args.spender);
    if (spenderBalance >= amount) return null;

    const fee = paymasterFeeIn(token, args.paymasterContext);
    if (fee === null) return null;

    const accountBalance = await args.read.balanceOf(token, args.account);
    if (accountBalance < amount + fee) return null;

    return {
        to: token,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [args.spender, amount] }),
    };
}

/**
 * What the paymaster will charge for this transaction, when it charges in the
 * same token the prefund goes out in. Anything else, or a sponsored transaction,
 * takes nothing from the balance the prefund comes out of.
 */
function paymasterFeeIn(token: Address, context?: Record<string, unknown>): bigint | null {
    const contextToken = context?.token as string | undefined;
    const gas = context?.gas as string | bigint | undefined;
    if (contextToken?.toLowerCase() !== token.toLowerCase()) return 0n;
    // A context that names this token but no `gas` is the path where
    // `createErc20ApprovalCall` sizes the ceiling itself, so the paymaster does
    // charge here and there is a fee to leave behind; we just cannot see it from
    // this side. Null, like an unreadable one: sending the transfer against a
    // fee we cannot size is how the account ends up short in postOp.
    if (gas === undefined) return null;
    try {
        return BigInt(gas);
    } catch {
        // The context reaches here from the grant request, so this is a number
        // the requester wrote. Null rather than zero: a fee we cannot read is
        // one we cannot leave room for, and sending the transfer anyway is how
        // the account ends up short and takes the grant down with it.
        return null;
    }
}

/**
 * Whether a spend entry names `token`.
 *
 * The address arrives as whatever the requester wrote, so the comparison is
 * case-insensitive and tolerates surrounding space. One place, because the two
 * callers below would otherwise each carry their own copy of that rule and only
 * one of them would get fixed the day it turns out to be wrong.
 */
function isSameToken(candidate: string | undefined, token: Address): boolean {
    return candidate?.trim().toLowerCase() === token.toLowerCase();
}

/** The first token the permission authorises spending, native ones aside. */
function firstErc20Spend(permissions: PermissionsDetail): Address | null {
    for (const spend of permissions.spends ?? []) {
        const token = spend.token?.trim();
        if (!token) continue;
        if (isSameToken(token, NATIVE_TOKEN)) continue;
        return token as Address;
    }
    return null;
}
