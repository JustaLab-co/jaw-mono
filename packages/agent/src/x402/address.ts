import { isAddress } from 'viem';

/**
 * An address a counterparty can actually read.
 *
 * viem's `isAddress` is strict by default: an all-lowercase string passes and
 * a correctly checksummed one passes, and anything else is refused, because a
 * mixed-case string that fails EIP-55 is indistinguishable from a typo. Every
 * other client in this flow hits the same wall, so a challenge advertising one
 * cannot be turned into a payment document anybody downstream can parse.
 *
 * Not a round-trip through `getAddress`, which is a different and wrong test:
 * `getAddress` returns the checksummed spelling, so an all-lowercase address
 * fails to round-trip while being perfectly readable. Strict `isAddress` is
 * the predicate, and it is what every counterparty applies.
 *
 * We cannot paper over it by re-casing, because `accepted` echoes the chosen
 * requirement byte for byte so the server can verify against what it
 * advertised. Normalising the payload while echoing the original leaves the
 * two halves of one document disagreeing, and a verifier comparing them
 * refuses after the payer has been funded, which is the failure this path
 * exists to remove.
 *
 * So it is refused instead, in `checkPolicy`, during selection: the option is
 * skipped before anything is funded, a sibling option on the same challenge
 * still pays, and a dry run reports it. Casing was never worth refusing when
 * refusing meant throwing after the top-up. It is worth refusing for free.
 */
export const isPayableAddress = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && isAddress(value);

/**
 * Shape alone, so a refusal can tell a field that is absent or garbage apart
 * from one that is present and merely unreadable. The two send whoever reads
 * the refusal to different places, so they do not share a message.
 */
export const isHexShaped = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * address(0) has the shape and none of the meaning. As a facilitator the proxy
 * reverts with `UnauthorizedFacilitator` for every caller, since nobody calls
 * from the zero address; as a `payTo` USDC itself reverts, since FiatToken's
 * `_transfer` requires a non-zero recipient and the Permit2 path reaches the
 * same check. Neither burns anything, but both cost the payer a top-up and
 * then reserve their full figure against the caps, on the rule that a failed
 * attempt may still have been broadcast.
 */
export const isZeroAddress = (value: string): boolean => /^0x0{40}$/.test(value);
