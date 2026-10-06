import type { UsdcAsset } from './asset-registry.js';

/**
 * The USDC a refill leaves behind so the next one can pay its own fee, in base
 * units of `asset`.
 *
 * Measured rather than guessed: a session's first operation, the most expensive
 * one it sends because it carries the EIP-7702 authorization and bootstraps the
 * permission manager as a co-owner, cost 0.0094 USDC on Base Sepolia. A tenth of
 * a token leaves ten times that.
 *
 * The grant seeds the session too, but it prices its own amount off the
 * paymaster's rate for the token (`account/spenderPrefund.ts` in @jaw.id/core),
 * so this is not a copy of that number and the two do not have to match. All
 * that is asked of either is that it covers an operation.
 *
 * It costs the granted allowance 0.10 once per session and not once per refill:
 * a refill fills the payer to price plus reserve, the payment takes the price,
 * and the reserve stays for the next one.
 *
 * An `upto` session asks for a second one on the payment that grants the
 * Permit2 allowance. That approval is an operation the payer pays for out of
 * its own balance, and a payer holding exactly the price cannot, so the bar for
 * skipping the refill rises by a reserve on top of the one every refill leaves.
 * The approval spends about a hundredth of it and the rest stays in the payer,
 * the same as the first.
 */
export function gasReserve(asset: UsdcAsset): bigint {
  return 10n ** BigInt(asset.decimals) / 10n;
}

/**
 * What one operation costs the session, in base units of `asset`.
 *
 * A cent, rounded up from the 0.0094 measured above so the figure stays a round
 * number rather than pretending to a precision a gas price does not have. It is
 * the floor a session has to clear to be able to send anything at all, which is
 * a different question from `gasReserve`: that one decides how much to leave
 * behind, this one decides whether there is enough to act.
 *
 * It is also the bar a clamped refill has to clear, for the same reason: below
 * one operation there is no amount worth pulling, because the transfer cannot
 * pay for itself. Above it the fee is no longer predicted at all, since
 * `ensurePayerFunds` reads the payer balance back once the refill lands and
 * refuses there on whatever the fee turned out to be. Widening this bar past one
 * operation only buys a guess the measurement already covers, and it costs the
 * tail of every period cap: a cap holding the price and a cent is a payment that
 * settles, and a wider bar refuses it with nothing moved.
 */
export function firstOperationCost(asset: UsdcAsset): bigint {
  return 10n ** BigInt(asset.decimals) / 100n;
}
