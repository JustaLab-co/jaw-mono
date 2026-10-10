import { bytesToHex } from 'viem';
import { isHexShaped, isPayableAddress, isZeroAddress } from './address.js';
import type { X402PaymentPayload, X402Permit2Authorization, X402PaymentRequirement } from './types.js';
import { usdcForNetwork } from './asset-registry.js';
import { settlementWindow } from './scheme-exact-evm.js';
import {
  PERMIT_WITNESS_TRANSFER_FROM_TYPES,
  UPTO_VERIFIED_CHAIN_IDS,
  isUptoVerifiedChain,
  X402_UPTO_PROXY_ADDRESS,
  permit2Domain,
  type UptoPermitMessage,
} from './permit2.js';

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
  const deadline = BigInt(nowSec + settlementWindow(requirement));
  const validAfter = BigInt(Math.max(nowSec - VALID_AFTER_SLACK, 0));
  const nonce = opts.nonce ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

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
