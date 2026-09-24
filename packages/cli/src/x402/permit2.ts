import type { UsdcChainId } from './asset-registry.js';

/**
 * Permit2 declarations for the x402 `upto` scheme.
 *
 * `upto` does not settle through EIP-3009 the way `exact` does. The client signs
 * a Permit2 `permitWitnessTransferFrom` authorizing a ceiling, and the
 * facilitator later calls the x402 proxy with the amount the run actually
 * consumed, which the proxy refuses if it exceeds the ceiling. The witness binds
 * both the recipient and the facilitator, so a signature is not useful to anyone
 * else.
 *
 * Everything here is a declaration: the addresses, the structs, and the domain.
 * Hashing them is viem's job. Choosing a nonce, a deadline, a spender or an
 * amount, and deciding whether a challenge may be paid at all, belongs to the
 * scheme module and the policy, not to this file.
 */

/**
 * Canonical Permit2, the same address `JustaPermissionManager` pins as its
 * `PERMIT2` constant. Deployed deterministically, so it does not vary per chain.
 */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

/**
 * `x402UptoPermit2Proxy`, the spender the payer authorizes and the only contract
 * allowed to settle the permit.
 *
 * Pinned rather than read from the challenge. The spender is what a Permit2
 * signature hands the ability to move funds to, so accepting a server-supplied
 * one would authorize a stranger to pull up to the ceiling. This is the same
 * rule the `exact` scheme already applies to the token address.
 *
 * Verified on chain on 2026-08-28, not just read from a repo: deployed at this
 * address on both Base Mainnet and Base Sepolia with an identical codehash
 * (`0x4662dc27...`), which is what a deterministic CREATE2 deployment should
 * look like. The runtime bytecode contains the witness type string and the
 * typehash below as literals, so the transcription is checked against the
 * contract that will actually run and not only against its source.
 *
 * Two traps live near this address. The x402 README still lists Base Mainnet as
 * having no `upto` deployment, which is stale. And Base Sepolia carries a
 * second, legacy proxy at `0x402039b3d6E6BEC5A02c2C9fd937ac17A6940002` with
 * different bytecode, predating the deterministic build. Nothing refuses a
 * challenge that names it: the spender is not read off the wire at all, this
 * constant is written into every permit, and a challenge advertising the legacy
 * proxy is signed for this one instead. Substituting silently is the safe
 * direction, since the permit stays worth its ceiling only to the address
 * pinned here, but it is a substitution and not a refusal.
 */
export const X402_UPTO_PROXY_ADDRESS = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002' as const;

/**
 * The chains the proxy above was verified on, and therefore the only ones an
 * `upto` payment may be signed for.
 *
 * The asset registry is wider than this: it also carries USDC on Polygon, and
 * nothing about a deterministic address makes a contract exist on a chain
 * nobody deployed it to. Signing a permit whose spender has no code
 * produces an authorization that can never settle, and by the ledger's own rule
 * a failed attempt reserves its whole ceiling against the cap, so the cost of
 * guessing lands on the user. Allow what was checked, refuse the rest, and widen
 * this when a deployment is confirmed rather than assumed.
 */
export const UPTO_VERIFIED_CHAIN_IDS: readonly UsdcChainId[] = [8453, 84532];

/** Whether `upto` may be signed for this chain. */
export function isUptoVerifiedChain(chainId: UsdcChainId): boolean {
  return UPTO_VERIFIED_CHAIN_IDS.includes(chainId);
}

/**
 * `WITNESS_TYPE_STRING` from `x402UptoPermit2Proxy.sol`, reproduced verbatim.
 * Permit2 concatenates it onto its own stub to form the full type, so the two
 * halves below must stay exactly as the contracts spell them: the struct order
 * (TokenPermissions before Witness) is the alphabetical order EIP-712 requires,
 * and a single byte out of place produces a signature that no verifier accepts
 * and no error explains.
 */
const UPTO_WITNESS_TYPE_STRING =
  'Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)';

/** Permit2's `_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB`. */
const PERMIT_TRANSFER_FROM_WITNESS_STUB =
  'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,';

/** The canonical EIP-712 type string for what the payer signs under `upto`. */
export const PERMIT2_UPTO_CONTENTS_TYPE = PERMIT_TRANSFER_FROM_WITNESS_STUB + UPTO_WITNESS_TYPE_STRING;

/**
 * The same structs as a viem types object. This is what actually gets signed, on
 * both validation paths: viem derives the canonical type from it, which is what
 * makes the string above a check on this rather than a second copy of it.
 */
export const PERMIT_WITNESS_TRANSFER_FROM_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;

/** What the payer authorizes: a ceiling, a spender, and the witness binding. */
export interface UptoPermitMessage {
  permitted: { token: `0x${string}`; amount: bigint };
  spender: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  witness: { to: `0x${string}`; facilitator: `0x${string}`; validAfter: bigint };
}

/**
 * Permit2's EIP-712 domain. It carries no `version`, so passing an empty one
 * would produce a domain separator the contract never computes and a signature
 * it never accepts.
 */
export function permit2Domain(chainId: number): { name: string; chainId: number; verifyingContract: `0x${string}` } {
  return { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS };
}
