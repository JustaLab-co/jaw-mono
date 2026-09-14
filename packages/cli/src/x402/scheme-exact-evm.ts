import { randomBytes } from 'node:crypto';
import { isPayableAddress, isZeroAddress } from './address.js';
import { usdcForNetwork } from './asset-registry.js';
import type { X402EIP3009Authorization, X402PaymentPayload, X402PaymentRequirement } from './types.js';

// EIP-712 struct for USDC's EIP-3009 `transferWithAuthorization`, the `exact`
// scheme's on-chain settlement.
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** The fully-formed EIP-712 payload handed to the injected signer. */
export interface ExactTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: 'TransferWithAuthorization';
  message: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: `0x${string}`;
  };
}

/**
 * Signs the typed data and returns the 65-byte `r||s||v` signature. Injected so
 * the payer decides the key: pull mode signs with the session-key EOA; a push
 * payer would settle without an off-chain signature.
 */
export type ExactSigner = (typedData: ExactTypedData) => Promise<`0x${string}`>;

export interface BuildExactOptions {
  /** Override "now" (unix seconds) for deterministic tests. */
  now?: number;
  /** Override the 32-byte nonce for deterministic tests. */
  nonce?: `0x${string}`;
}

/**
 * Build and sign the `exact`-scheme payment for one chosen requirement. `from`
 * is the payer address (the session-key EOA in pull mode). Each call uses a
 * fresh nonce; the server's replay protection rejects reuse of a stale proof.
 */
export async function buildExactPayment(
  requirement: X402PaymentRequirement,
  from: `0x${string}`,
  sign: ExactSigner,
  opts: BuildExactOptions = {}
): Promise<X402PaymentPayload> {
  // Signing an `upto` ceiling as a fixed EIP-3009 transfer would move the whole
  // ceiling and call it a price. The two builders each refuse the other's work.
  if (requirement.scheme !== 'exact') {
    throw new Error(`Not an exact requirement: ${requirement.scheme}`);
  }

  const asset = usdcForNetwork(requirement.network);
  if (!asset) throw new Error(`Unsupported x402 network: ${requirement.network}`);
  // `requirement.asset` is server-controlled; signing with it as the
  // verifyingContract would authorize a transfer on an arbitrary ERC-3009
  // token. The registry is the source of truth for USDC on each network.
  if (requirement.asset.toLowerCase() !== asset.address.toLowerCase()) {
    throw new Error(
      `x402 asset mismatch on ${requirement.network}: server asked for ${requirement.asset}, known USDC is ${asset.address}`
    );
  }

  // `checkPolicy` refuses both of these during selection, before anything is
  // funded; the signer keeps its own preconditions, as it does for the asset
  // above. The mismatch check is case-insensitive on purpose, so it is these
  // that keep an unreadable address from reaching viem, which would throw at
  // signing time with the payer already topped up. See address.ts.
  // `asset` as well as `payTo`: the mismatch check above is case-insensitive, so
  // an unreadable spelling of the registry's USDC passes it, and while the
  // domain uses the registry value, `accepted` carries the advertised one out.
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

  // The registry's own spelling, for the reason the mismatch check exists: it
  // is the source of truth, and the two are now known to be the same address.
  const verifyingContract = asset.address;

  // The registry's, and never `extra.name`/`extra.version`, which this used to
  // prefer.
  //
  // `extra` is server-controlled (`z.record(z.unknown())` in http.ts), and for
  // a token the registry knows the server's claim can only be equal, in which
  // case it adds nothing, or different, in which case it is a signature the
  // token rejects. That reads back as a failed payment and reserves its whole
  // ceiling against the caps, once per call, while `x402 status` still reports
  // ready because it measures the registry rather than what was signed.
  //
  // The registry cannot be wrong quietly either: `whyEip712DomainDisagrees`
  // compares it against the separator the token verifies against, in
  // `x402 status`, which is where a network read belongs and this is not.

  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const validAfter = '0';
  // The authorization must stay valid until the facilitator's settlement tx is
  // MINED, which includes verify + submit + block time on top of our signing.
  // A server's advertised maxTimeoutSeconds is often as low as 60s — too tight,
  // so the auth can expire before settlement and the transfer reverts. Give a
  // generous floor; a longer-valid authorization is harmless because the
  // EIP-3009 nonce is single-use.
  const SETTLEMENT_WINDOW_FLOOR = 600;
  const window = Math.max(requirement.maxTimeoutSeconds || 0, SETTLEMENT_WINDOW_FLOOR);
  const validBefore = String(nowSec + window);
  const nonce = opts.nonce ?? (`0x${randomBytes(32).toString('hex')}` as `0x${string}`);

  const authorization: X402EIP3009Authorization = {
    from,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await sign({
    domain: { name: asset.usdcName, version: asset.usdcVersion, chainId: asset.chainId, verifyingContract },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to: requirement.payTo,
      value: BigInt(requirement.amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  return { x402Version: 2, accepted: requirement, payload: { signature, authorization } };
}

/** Base64-encode a payment payload for the `PAYMENT-SIGNATURE` header. */
export function encodePaymentPayload(payload: X402PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}
