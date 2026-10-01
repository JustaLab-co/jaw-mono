import { randomBytes } from 'node:crypto';
import { isHexShaped, isPayableAddress, isZeroAddress } from './address.js';
import { usdcForNetwork } from './asset-registry.js';
import {
  PERMIT_WITNESS_TRANSFER_FROM_TYPES,
  UPTO_VERIFIED_CHAIN_IDS,
  isUptoVerifiedChain,
  X402_UPTO_PROXY_ADDRESS,
  permit2Domain,
  type UptoPermitMessage,
} from './permit2.js';
import type { X402PaymentPayload, X402Permit2Authorization, X402PaymentRequirement } from './types.js';

/**
 * The `upto` scheme on EVM: authorize a ceiling, get charged for what was used.
 *
 * The client signs a Permit2 `permitWitnessTransferFrom` for the ceiling the
 * server advertised. The facilitator later calls `x402UptoPermit2Proxy.settle`
 * with the amount the run actually consumed, and the proxy reverts with
 * `AmountExceedsPermitted` above the ceiling and with `UnauthorizedFacilitator`
 * unless the caller is the address named in the witness. So the exposure of one
 * signature is exactly the ceiling, paid to the recipient the witness names, by
 * the facilitator the witness names, once.
 *
 * Two preconditions this module does not enforce, because they are not its job:
 * the payer must have approved Permit2 on the token, and the policy must have
 * already agreed to the ceiling. Signing before either is a payment that cannot
 * settle, or one that should not have been made.
 */

/** The fully-formed EIP-712 payload handed to the injected signer. */
export interface UptoTypedData {
  domain: ReturnType<typeof permit2Domain>;
  types: typeof PERMIT_WITNESS_TRANSFER_FROM_TYPES;
  primaryType: 'PermitWitnessTransferFrom';
  message: UptoPermitMessage;
}

/** Signs the typed data and returns the signature, raw or ERC-7739 wrapped. */
export type UptoSigner = (typedData: UptoTypedData) => Promise<`0x${string}`>;

export interface BuildUptoOptions {
  /** Override "now" (unix seconds) for deterministic tests. */
  now?: number;
  /** Override the 32-byte nonce for deterministic tests. */
  nonce?: `0x${string}`;
}

/**
 * The authorization must stay valid until the facilitator's settlement is
 * MINED. Servers advertise timeouts as low as 60s, which is not enough for
 * verify, submit and a block, so the exact scheme learned to floor it at ten
 * minutes and this one inherits the lesson. A longer window costs nothing: the
 * Permit2 nonce is single-use, so the signature dies on first settlement
 * whether or not the deadline has passed.
 */
const SETTLEMENT_WINDOW_FLOOR = 600;

/**
 * And a ceiling, because the server picks this number too. A challenge is free
 * to advertise a year, and the deadline is what decides how long a failed
 * attempt keeps its ceiling reserved against the cap, so an absurd window parks
 * the user's budget for as long as the server likes. An hour is generous for
 * verify, submit and mine.
 */
const SETTLEMENT_WINDOW_CEILING = 3600;

/**
 * Backdating for clock skew. `validAfter` is a floor the proxy checks against
 * block time, and a client running a minute ahead of the chain would sign an
 * authorization that is not valid yet. Widening it downward only shortens the
 * window in which nothing could have settled anyway, since the deadline is what
 * bounds the exposure.
 */
const VALID_AFTER_SLACK = 60;

/**
 * Build and sign the `upto` payment for one chosen requirement. `from` is the
 * payer, the account Permit2 will pull from. Each call uses a fresh nonce;
 * Permit2's bitmap rejects a reused one.
 */
export async function buildUptoPayment(
  requirement: X402PaymentRequirement,
  from: `0x${string}`,
  sign: UptoSigner,
  opts: BuildUptoOptions = {}
): Promise<X402PaymentPayload> {
  if (requirement.scheme !== 'upto') {
    throw new Error(`Not an upto requirement: ${requirement.scheme}`);
  }

  const asset = usdcForNetwork(requirement.network);
  if (!asset) throw new Error(`Unsupported x402 network: ${requirement.network}`);
  // The registry knows more chains than the proxy was verified on, and a permit
  // pointing at a spender with no code is one nobody can settle. `checkPolicy`
  // already refuses these during selection, before anything is funded; this is
  // the signer's own precondition, for a caller that reaches it another way.
  if (!isUptoVerifiedChain(asset.chainId)) {
    throw new Error(
      `x402 upto is not available on ${requirement.network}: the settlement proxy is only verified on ` +
        `chain ids ${UPTO_VERIFIED_CHAIN_IDS.join(', ')}`
    );
  }
  // Same rule the exact scheme applies: `requirement.asset` is server-supplied,
  // and signing over an arbitrary token would authorize a transfer of something
  // we never agreed to move. The registry is the source of truth.
  if (requirement.asset.toLowerCase() !== asset.address.toLowerCase()) {
    throw new Error(
      `x402 asset mismatch on ${requirement.network}: server asked for ${requirement.asset}, known USDC is ${asset.address}`
    );
  }

  // `checkPolicy` refuses all of these during selection, before anything is
  // funded; like the chain check above, they are the signer's own preconditions
  // for a caller that reaches it another way.
  //
  // `asset` as well as `payTo`: the mismatch check above is case-insensitive, so
  // an unreadable spelling of the registry's USDC passes it, and while the
  // signed message uses the registry value, `permitted.token` and `accepted`
  // both carry the advertised one out to the facilitator.
  for (const [field, value] of [
    ['asset', requirement.asset],
    ['payTo', requirement.payTo],
  ] as const) {
    if (!isPayableAddress(value)) {
      throw new Error(`x402 ${field} is not a readable address on ${requirement.network}: ${value}`);
    }
  }
  if (isZeroAddress(requirement.payTo)) {
    throw new Error(`x402 payTo is the zero address on ${requirement.network}`);
  }

  // The witness names the only address the proxy will accept as the settling
  // caller. Without it there is nothing to bind, and a payment nobody can settle
  // is worse than a refusal: it consumes the ceiling in the ledger for nothing.
  const advertisedFacilitator = requirement.extra?.['facilitatorAddress'];
  if (!isHexShaped(advertisedFacilitator) || isZeroAddress(advertisedFacilitator)) {
    throw new Error(
      `x402 upto needs a settling facilitator in extra.facilitatorAddress on ${requirement.network}, ` +
        `got ${JSON.stringify(advertisedFacilitator)}`
    );
  }
  // Present and the right shape but unreadable: a different problem from an
  // absent one, and it sends whoever reads this somewhere else.
  if (!isPayableAddress(advertisedFacilitator)) {
    throw new Error(
      `x402 extra.facilitatorAddress is not a readable address on ${requirement.network}: ${advertisedFacilitator}`
    );
  }

  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const window = Math.min(
    Math.max(requirement.maxTimeoutSeconds || 0, SETTLEMENT_WINDOW_FLOOR),
    SETTLEMENT_WINDOW_CEILING
  );
  const deadline = BigInt(nowSec + window);
  const validAfter = BigInt(Math.max(nowSec - VALID_AFTER_SLACK, 0));
  const nonce = opts.nonce ?? (`0x${randomBytes(32).toString('hex')}` as `0x${string}`);

  const message: UptoPermitMessage = {
    permitted: { token: asset.address, amount: BigInt(requirement.amount) },
    spender: X402_UPTO_PROXY_ADDRESS,
    nonce: BigInt(nonce),
    deadline,
    witness: { to: requirement.payTo, facilitator: advertisedFacilitator, validAfter },
  };

  const signature = await sign({
    domain: permit2Domain(asset.chainId),
    types: PERMIT_WITNESS_TRANSFER_FROM_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message,
  });

  // Numbers go back out as strings, the way they arrived. `nonce` stays hex
  // because that is the width it is: 32 bytes of bitmap coordinate, not a count.
  //
  // Every address goes back out exactly as the challenge advertised it, which
  // is also how `accepted` echoes it, so the two halves of the document agree
  // and a facilitator matching either against its own strings sees its own
  // casing. Nothing here needs re-casing: `checkPolicy` and the preconditions
  // above already refused anything a counterparty could not read.
  const permit2Authorization: X402Permit2Authorization = {
    permitted: { token: requirement.asset, amount: message.permitted.amount.toString() },
    from,
    spender: message.spender,
    nonce,
    deadline: deadline.toString(),
    witness: { to: requirement.payTo, facilitator: advertisedFacilitator, validAfter: validAfter.toString() },
  };

  return { x402Version: 2, accepted: requirement, payload: { signature, permit2Authorization } };
}
