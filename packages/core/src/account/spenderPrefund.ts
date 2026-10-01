import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { NATIVE_TOKEN } from '../rpc/permissions.js';
import type { PermissionsDetail } from '../rpc/permissions.js';

/**
 * The spender of a permission sends every userOp that permission authorises, and
 * the ERC-20 paymaster charges the sender. Nothing funds the spender before its
 * first op, so without help that op has no fee source and has to be sponsored.
 *
 * The grant is the one transaction the account owner already signs, so it is
 * where the spender gets what it needs. This sizes the transfer that rides
 * along in it, in two steps: a quote before the grant screen renders, so the
 * user sees what leaves the account and where it goes, and a check at the
 * grant, so what is sent is exactly what they saw.
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
 * `@jaw.id/cli` encodes that same rule a second time, in `policyFromPermission`
 * (`x402/policy.ts`), keeping every matching limit rather than reducing them
 * because it has to report which one refuses. One fact, two encodings, either
 * side of a boundary the CLI deliberately does not cross at startup. A change to
 * what the contract charges lands in both.
 *
 * They fail differently, and on purpose. An unreadable allowance is null here
 * and no prefund goes out; the CLI skips that entry and keeps enforcing the
 * rest. This is the side that is about to move funds.
 *
 * A permission too tight to cover one operation is refused outright by
 * `quoteSpenderPrefund` rather than trimmed to it.
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

/**
 * A transfer to the spender, sized before the grant screen renders so the screen
 * can show it. What it shows is what goes out: `Account.grantPermissions` sends
 * this amount as is and never prices it again.
 */
export interface SpenderPrefund {
    /** The permission's own spend token, and the one the transfer moves. */
    token: Address;
    /** The spender being approved, and the only possible destination. */
    spender: Address;
    /** In the token's smallest unit. */
    amount: bigint;
}

/**
 * What `quoteSpenderPrefund` found. `transfer` is one to show and send.
 * `below-one-operation` is the decline a person can act on, by granting more:
 * the allowance is under what one operation costs, so no transfer the
 * permission allows could fund the session.
 */
export type SpenderPrefundQuote =
    | ({ kind: 'transfer' } & SpenderPrefund)
    | { kind: 'below-one-operation'; token: Address; allowance: bigint; operationCost: bigint };

/** Options for the grant. */
export interface GrantPermissionsOptions {
    /**
     * A transfer from `quoteSpenderPrefund` to ride along in the grant, so the
     * spender's first userOp can pay its own fee. Checked against the
     * permission and the account's balance before anything is sent, and the
     * grant fails rather than send something other than this.
     *
     * The paymaster `gas` passed with it has to be sized over a batch that
     * includes `spenderPrefundCall(prefund)`: the transfer is part of what the
     * transaction costs.
     */
    prefund?: SpenderPrefund;
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

export interface PrefundQuoteArgs {
    /** The account granting the permission, which the transfer comes out of. */
    account: Address;
    /** The address being approved as spender, and the only possible destination. */
    spender: Address;
    permissions: PermissionsDetail;
    read: PrefundReader;
}

/**
 * The transfer that funds the spender's first operation, or why there is none
 * the user could act on. Null when it is not needed or not affordable, which
 * the screen has nothing to say about.
 *
 * Not the fee: that depends on a batch the transfer is part of, so it is
 * checked at the grant, by `checkSpenderPrefund`, against an estimate that
 * includes this.
 */
export async function quoteSpenderPrefund(args: PrefundQuoteArgs): Promise<SpenderPrefundQuote | null> {
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
    const operationCost = priceOf(FIRST_OP_GAS);
    if (operationCost > ceiling) {
        return { kind: 'below-one-operation', token, allowance: ceiling, operationCost };
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

    // Nothing to show for a transfer the account could not make. The fee comes
    // on top of this and is checked at the grant.
    const accountBalance = await args.read.balanceOf(token, args.account);
    if (accountBalance < amount) return null;

    return { kind: 'transfer', token, spender: args.spender, amount };
}

/** The ERC-20 transfer a prefund sends, for the grant and for estimating it. */
export function spenderPrefundCall(prefund: SpenderPrefund): { to: Address; value: bigint; data: Hex } {
    return {
        to: prefund.token,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [prefund.spender, prefund.amount] }),
    };
}

export interface PrefundCheckArgs {
    prefund: SpenderPrefund;
    account: Address;
    spender: Address;
    permissions: PermissionsDetail;
    /**
     * The paymaster context for this transaction. When it names the prefund's
     * token, its `gas` is what the paymaster will take from `account` on top of
     * the transfer.
     */
    paymasterContext?: Record<string, unknown>;
    read: Pick<PrefundReader, 'balanceOf'>;
}

/**
 * The transfer a quoted prefund sends, once it has been checked against the
 * grant it rides in. Throws, before anything is sent, when the grant cannot send
 * exactly what the screen showed.
 *
 * The quote reaches here through the caller, so it is held to the same rules it
 * was built under: the destination is the spender being approved, the token is
 * the one the permission spends, and the amount fits inside its allowance.
 */
export async function checkSpenderPrefund(args: PrefundCheckArgs): Promise<{ to: Address; value: bigint; data: Hex }> {
    const { prefund } = args;

    if (prefund.spender.toLowerCase() !== args.spender.toLowerCase()) {
        throw new Error(`The spender prefund is addressed to ${prefund.spender}, not to the spender being approved.`);
    }
    const token = firstErc20Spend(args.permissions);
    if (!token || token.toLowerCase() !== prefund.token.toLowerCase()) {
        throw new Error(`The spender prefund is in ${prefund.token}, which is not the token this permission spends.`);
    }
    const ceiling = ceilingFor(args.permissions, token);
    if (prefund.amount <= 0n || ceiling === null || prefund.amount > ceiling) {
        throw new Error('The spender prefund is larger than the permission allows.');
    }

    const fee = paymasterFeeIn(prefund.token, args.paymasterContext);
    if (fee === null) {
        // Sending the transfer against a fee we cannot size is how the account
        // ends up short in postOp, reverting the grant after it was signed.
        throw new Error(
            'Could not size the fee this grant pays in the prefund token, so the prefund cannot be checked. ' +
                'Estimate the grant with the prefund included, or pay the fee in another token.'
        );
    }

    const balance = await args.read.balanceOf(prefund.token, args.account);
    if (balance < prefund.amount + fee) {
        throw new Error(
            `The account no longer holds the ${prefund.amount} of ${prefund.token} shown for the spender` +
                (fee > 0n ? ', with the fee on top' : '') +
                '. Nothing was sent.'
        );
    }

    return spenderPrefundCall(prefund);
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
    // this side. Null, like an unreadable one.
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
