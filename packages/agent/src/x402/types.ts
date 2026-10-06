// x402 v2 wire types — the client-side subset the CLI needs. Names mirror the
// backend's `apps/ens/src/external/payment/x402-types.ts` so the buyer and
// seller sides stay wire-compatible. v2 only (no v1 `X-PAYMENT` / `maxAmountRequired`).

/**
 * The settlement schemes this client can produce a payment for.
 *
 * One list, because more than one place has to answer the same question about
 * an untrusted string off the wire: the policy refuses what it cannot bound,
 * the challenge selector refuses what it cannot sign, and discovery must not
 * advertise a price the payment path would then decline to pay.
 */
export const X402_SCHEMES = ['exact', 'upto'] as const;

export type X402Scheme = (typeof X402_SCHEMES)[number];

export function isX402Scheme(value: unknown): value is X402Scheme {
  return typeof value === 'string' && (X402_SCHEMES as readonly string[]).includes(value);
}

/** One acceptable payment option from the server's `accepts` list. */
export interface X402PaymentRequirement {
  scheme: X402Scheme;
  /** CAIP-2 network id, e.g. `eip155:8453`. */
  network: string;
  /** Base units, decimal string. */
  amount: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  /** Absent on some servers; treated as 0 (the settlement-window floor applies). */
  maxTimeoutSeconds?: number;
  /** Scheme-specific extension (for exact-evm, the EIP-712 domain name/version). */
  extra?: Record<string, unknown>;
}

/** Top-level resource metadata, hoisted out of per-accepts in v2. */
export interface X402Resource {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/**
 * The v2 PaymentRequired challenge — base64-decoded from the `PAYMENT-REQUIRED`
 * response header (the HTTP body stays an opaque `{}`).
 */
export interface X402PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: X402Resource;
  accepts: X402PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

/** EIP-3009 `transferWithAuthorization` signed message (shared by x402 and MPP). */
export interface X402EIP3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

/** Signed message + signature — the payload of the `exact` scheme on EVM. */
export interface X402ExactPayload {
  signature: `0x${string}`;
  authorization: X402EIP3009Authorization;
}

/**
 * Permit2 `permitWitnessTransferFrom` authorization, the payload of the `upto`
 * scheme on EVM. `permitted.amount` is the ceiling; the facilitator settles for
 * the amount actually consumed, which the proxy refuses above the ceiling. The
 * witness binds the recipient and the only address allowed to settle.
 */
export interface X402Permit2Authorization {
  permitted: { token: `0x${string}`; amount: string };
  from: `0x${string}`;
  spender: `0x${string}`;
  nonce: `0x${string}`;
  deadline: string;
  witness: { to: `0x${string}`; facilitator: `0x${string}`; validAfter: string };
}

/** Signed message + signature — the payload of the `upto` scheme on EVM. */
export interface X402UptoPayload {
  signature: `0x${string}`;
  permit2Authorization: X402Permit2Authorization;
}

/**
 * What the client sends back base64-encoded in `PAYMENT-SIGNATURE`. `accepted`
 * (singular) echoes the chosen requirement so the server verifies against what
 * it advertised.
 */
export interface X402PaymentPayload {
  x402Version: 2;
  accepted: X402PaymentRequirement;
  payload: X402ExactPayload | X402UptoPayload;
  extensions?: Record<string, unknown>;
}

/** Facilitator settle/verify result — decoded from `PAYMENT-RESPONSE`. */
export interface X402SettleResponse {
  success: boolean;
  transaction?: `0x${string}`;
  network?: string;
  payer?: `0x${string}`;
  errorReason?: string;
  amount?: string;
}

/** v2 HTTP header names (no `X-` prefix; case-insensitive on the wire). */
export const X402_HEADERS = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const;
