import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  isAddressEqual,
  keccak256,
  numberToHex,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import type { GrantedPermission } from '../session/session-config.js';
import type { Challenge } from '../x402/http.js';
import { exactDraft, SETTLEMENT_WINDOW_FLOOR, type ExactDraft } from '../x402/scheme-exact-evm.js';
import type { X402PaymentRequirement } from '../x402/types.js';
import { clientIdentity, type ClientIdentity } from './client-identity.js';
import { rejectionTypedData, RESERVED_PREFIX } from './reserved.js';

/** 16 random bytes, base64url. Unguessable: it is the read capability for the approval page. */
export type ApprovalId = string & { readonly __brand: 'ApprovalId' };

export const APPROVAL_TTL_MS = 10 * 60_000;
export const MAX_MESSAGE_CHARS = 4096;

export const TRANSFER_SIGNATURE = 'transfer(address,uint256)';

/** A daily USDC allowance the connection's session key may pull from the account. */
export interface BudgetBody {
  kind: 'budget';
  /** The connection's session key: the only spender a budget may name. */
  spender: Address;
  token: Address;
  /** Base units per day. */
  allowance: string;
  /** Unix seconds the permission ends. */
  expiry: number;
}

/** Everything the owner's signature binds, and all the page is derived from. */
export interface PaymentTerms {
  /** The final https url the challenge came from: the proof is sent there and nowhere else. */
  resource: string;
  /** The option as the seller advertised it. */
  requirement: X402PaymentRequirement & { scheme: 'exact' };
  nonce: Hex;
  /** Unix seconds, decimal. */
  validBefore: string;
}

/** Paying one 402 once from the account. How to fetch it again is kept apart, never on this object. */
export interface PaymentBody {
  kind: 'payment';
  terms: PaymentTerms;
}

/** What the agent asked for. */
export type ApprovalBody = { kind: 'signature'; message: string } | BudgetBody | PaymentBody;

/** The `wallet_grantPermissions` request the page executes, exactly as rendered. */
export interface GrantRequest {
  address: Address;
  spender: Address;
  expiry: number;
  /** Hex, as `wallet_grantPermissions` takes it. */
  chainId: Hex;
  permissions: {
    calls: { target: Address; functionSignature: string }[];
    spends: { token: Address; allowance: string; unit: 'day'; multiplier: 1 }[];
  };
  capabilities: { prefundSpender: true };
}

/** Exactly what the wallet signs or sends. Derived from the body, never stored apart from it. */
export type SignedPayload =
  | { type: 'message'; message: string }
  | { type: 'typed_data'; typedData: TypedDataDefinition }
  | { type: 'grant'; grant: GrantRequest };

/** How the account proved its decision: a signature, or a permission now approved on chain. */
export type DecisionProof =
  | {
      type: 'signature';
      /** Verified for the request's account on its chain. Carries the WebAuthn assertion. */
      signature: Hex;
      /** keccak256 of the signature: a stable reference to the passkey assertion inside it. */
      assertionRef: Hex;
    }
  | { type: 'permission'; permissionId: Hex };

export interface DecisionEvidence {
  /** keccak256 of the preview the page rendered. */
  previewHash: Hex;
  /** Hash of the payload the proof covers. */
  payloadHash: Hex;
  proof: DecisionProof;
  decidedAt: Date;
}

export type ApprovalState =
  | { status: 'pending' }
  | { status: 'approved'; evidence: DecisionEvidence }
  | { status: 'rejected'; evidence: DecisionEvidence }
  | { status: 'expired' };

export type ApprovalStatus = ApprovalState['status'];

export interface ApprovalRequest {
  id: ApprovalId;
  account: Address;
  chainId: number;
  /** The connected client: its self-declared name (third-party text) and its client id. */
  requester: { name: string; clientId: string };
  /** The connection's session key, the address a budget must name. */
  sessionAddress: Address;
  body: ApprovalBody;
  createdAt: Date;
  expiresAt: Date;
  state: ApprovalState;
}

export type Verdict = 'approved' | 'rejected';

export type DecideResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; refusal: 'expired' | 'already_decided'; request: ApprovalRequest };

export type PreviewWarning = 'hidden_characters' | 'address_like' | 'markup_like';

interface PreviewBase {
  requester: ClientIdentity;
  account: Address;
  chainId: number;
}

/** Built on the server and rendered verbatim by the page. */
export type Preview =
  | (PreviewBase & {
      kind: 'signature';
      /** The message with control, bidi and zero-width characters shown as ⟦U+XXXX⟧. */
      text: string;
      warnings: PreviewWarning[];
    })
  | (PreviewBase & {
      kind: 'budget';
      spender: Address;
      token: Address;
      /** Base units per day. */
      allowance: string;
      period: 'day';
      expiresAt: string;
    })
  | (PreviewBase & {
      kind: 'payment';
      payTo: Address;
      token: Address;
      /** Base units. */
      amount: string;
      network: string;
      /** Origin and path, hidden characters shown as ⟦U+XXXX⟧. The query is left out: it can carry a key. */
      resource: string;
      warnings: PreviewWarning[];
      /** When the signed authorization stops being spendable. */
      validUntil: string;
    });

/** The JSON the approval page reads. */
export interface ApprovalPageView {
  id: ApprovalId;
  status: ApprovalStatus;
  account: Address;
  chainId: number;
  expiresAt: string;
  preview: Preview;
  previewHash: Hex;
  approve: SignedPayload;
  reject: SignedPayload;
}

const ID = /^[A-Za-z0-9_-]{22}$/;

export function parseApprovalId(raw: string): ApprovalId | undefined {
  return ID.test(raw) ? (raw as ApprovalId) : undefined;
}

export type MessageRefusal = 'empty' | 'too_long' | 'reserved_prefix' | 'unstorable';

/** NUL and unpaired surrogates, which Postgres refuses in text and jsonb. */
export const hasUnstorableText = (text: string) => /[\0\p{Cs}]/u.test(text);

export function validateMessage(message: string): MessageRefusal | undefined {
  if (message.length === 0) return 'empty';
  if (message.length > MAX_MESSAGE_CHARS) return 'too_long';
  if (message.startsWith(RESERVED_PREFIX)) return 'reserved_prefix';
  if (hasUnstorableText(message)) return 'unstorable';
  return undefined;
}

/** Shortest window a person is given. A challenge leaving less gets no one-off. */
export const MIN_DECISION_MS = 60_000;

/**
 * Opens a payment approval. The one place the three clocks meet: the owner has
 * until the challenge times out (ten minutes at most), and the authorization
 * stays spendable a settlement window past the last possible decision.
 * Undefined when that leaves the owner under a minute. Throws on an option the
 * signer would refuse, so nothing unpayable is stored.
 */
export function openPaymentRequest(
  input: Pick<ApprovalRequest, 'id' | 'account' | 'chainId' | 'requester' | 'sessionAddress'>,
  offer: { resource: string; requirement: X402PaymentRequirement },
  now: Date,
  nonce: Hex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
): ApprovalRequest | undefined {
  const { requirement } = offer;
  if (requirement.scheme !== 'exact') throw new Error(`Not an exact requirement: ${requirement.scheme}`);
  const timeout = requirement.maxTimeoutSeconds ? requirement.maxTimeoutSeconds * 1000 : APPROVAL_TTL_MS;
  const window = Math.min(APPROVAL_TTL_MS, timeout);
  if (window < MIN_DECISION_MS) return undefined;
  const expiresAt = new Date(now.getTime() + window);
  const validBefore = String(Math.ceil(expiresAt.getTime() / 1000) + SETTLEMENT_WINDOW_FLOOR);
  const terms: PaymentTerms = {
    resource: offer.resource,
    requirement: { ...requirement, scheme: 'exact' },
    nonce,
    validBefore,
  };
  paymentDraft(input.account, terms);
  return { ...input, body: { kind: 'payment', terms }, createdAt: now, expiresAt, state: { status: 'pending' } };
}

/** The transfer the owner signs: from the account, everything else from the terms. */
export function paymentDraft(account: Address, terms: PaymentTerms): ExactDraft {
  return exactDraft(terms.requirement, account, { validBefore: terms.validBefore, nonce: terms.nonce });
}

/**
 * The option in a fresh challenge that is still what was signed: the same
 * resource, and an exact option whose network, asset, recipient and amount
 * equal the terms. Returned so it is sent as `accepted`: `extra` and the
 * timeout are not signed and may have changed.
 */
export function stillOffered(terms: PaymentTerms, fresh: Challenge): X402PaymentRequirement | undefined {
  if (fresh.resource !== terms.resource) return undefined;
  const signed = terms.requirement;
  return fresh.accepts.find(
    (option) =>
      option.scheme === 'exact' &&
      option.network === signed.network &&
      option.amount === signed.amount &&
      isAddressEqual(option.asset, signed.asset) &&
      isAddressEqual(option.payTo, signed.payTo)
  );
}

export function openRequest(
  input: Pick<ApprovalRequest, 'id' | 'account' | 'chainId' | 'requester' | 'sessionAddress' | 'body'>,
  now: Date
): ApprovalRequest {
  return {
    ...input,
    createdAt: now,
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    state: { status: 'pending' },
  };
}

/** Expiry is derived, never stored: a pending request at or past expiresAt reads as expired. */
export function atTime(request: ApprovalRequest, now: Date): ApprovalRequest {
  if (request.state.status !== 'pending' || now < request.expiresAt) return request;
  return { ...request, state: { status: 'expired' } };
}

/** The only transition. Only a pending request moves, and expiry wins over a late decision. */
export function decide(
  request: ApprovalRequest,
  verdict: Verdict,
  evidence: DecisionEvidence,
  now: Date
): DecideResult {
  const current = atTime(request, now);
  if (current.state.status === 'expired') return { ok: false, refusal: 'expired', request: current };
  if (current.state.status !== 'pending') return { ok: false, refusal: 'already_decided', request: current };
  return { ok: true, request: { ...current, state: { status: verdict, evidence } } };
}

function budgetOf(request: ApprovalRequest & { body: BudgetBody }): BudgetBody {
  if (!isAddressEqual(request.body.spender, request.sessionAddress)) {
    throw new Error('a budget may only name the connection session key as spender');
  }
  return request.body;
}

function grantOf(request: ApprovalRequest & { body: BudgetBody }): GrantRequest {
  const { spender, token, allowance, expiry } = budgetOf(request);
  return {
    address: request.account,
    spender,
    expiry,
    chainId: numberToHex(request.chainId),
    permissions: {
      calls: [{ target: token, functionSignature: TRANSFER_SIGNATURE }],
      spends: [{ token, allowance, unit: 'day', multiplier: 1 }],
    },
    capabilities: { prefundSpender: true },
  };
}

export function signedPayload(request: ApprovalRequest, verdict: Verdict): SignedPayload {
  if (verdict === 'rejected') return { type: 'typed_data', typedData: rejectionTypedData(request.chainId, request.id) };
  const { body } = request;
  switch (body.kind) {
    case 'signature':
      return { type: 'message', message: body.message };
    case 'budget':
      return { type: 'grant', grant: grantOf({ ...request, body }) };
    case 'payment':
      return { type: 'typed_data', typedData: paymentDraft(request.account, body.terms).typedData };
  }
}

export function payloadHash(payload: SignedPayload): Hex {
  switch (payload.type) {
    case 'message':
      return hashMessage(payload.message);
    case 'typed_data':
      return hashTypedData(payload.typedData);
    case 'grant':
      return keccak256(stringToHex(JSON.stringify(payload.grant)));
  }
}

/** Whether the permission granted on chain is exactly the one requested. Start and salt are the wallet's. */
export function grantMatches(grant: GrantRequest, permission: GrantedPermission): boolean {
  const [call] = grant.permissions.calls;
  const [spend] = grant.permissions.spends;
  const [granted] = permission.spends;
  return (
    isAddressEqual(permission.account as Address, grant.address) &&
    isAddressEqual(permission.spender as Address, grant.spender) &&
    permission.end === grant.expiry &&
    permission.calls.length === 1 &&
    isAddressEqual(permission.calls[0].target as Address, call.target) &&
    permission.calls[0].selector.toLowerCase() === toFunctionSelector(call.functionSignature) &&
    permission.spends.length === 1 &&
    isAddressEqual(granted.token as Address, spend.token) &&
    BigInt(granted.allowance) === BigInt(spend.allowance) &&
    granted.unit === spend.unit &&
    granted.multiplier === spend.multiplier
  );
}

// Every control, format (bidi, zero-width, tags), line and paragraph separator
// except newline and tab, plus every default-ignorable code point (variation
// selectors, the grapheme joiner, Hangul fillers) and the blank braille pattern.
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu;

const codePoint = (c: string) => `⟦U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}⟧`;

export function previewOf(request: ApprovalRequest): Preview {
  const base = {
    requester: clientIdentity(request.requester.clientId, request.requester.name),
    account: request.account,
    chainId: request.chainId,
  };
  const { body } = request;
  if (body.kind === 'budget') {
    const { spender, token, allowance, expiry } = budgetOf({ ...request, body });
    const expiresAt = new Date(expiry * 1000).toISOString();
    return { kind: 'budget', ...base, spender, token, allowance, period: 'day', expiresAt };
  }
  if (body.kind === 'payment') return previewOfPayment(base, body.terms);
  const text = body.message.replace(HIDDEN, codePoint);
  const warnings: PreviewWarning[] = [];
  if (text !== body.message) warnings.push('hidden_characters');
  if (/0x[0-9a-fA-F]{40}/.test(body.message)) warnings.push('address_like');
  if (/<[a-zA-Z!/]/.test(body.message)) warnings.push('markup_like');
  return { kind: 'signature', ...base, text, warnings };
}

// Read from the typed data the owner signs, and from the terms alone: nothing
// else on a request can reach the page through it.
function previewOfPayment(base: PreviewBase, terms: PaymentTerms): Preview {
  const { domain, message } = paymentDraft(base.account, terms).typedData;
  const { origin, pathname } = new URL(terms.resource);
  const resource = `${origin}${pathname}`.replace(HIDDEN, codePoint);
  return {
    kind: 'payment',
    ...base,
    payTo: message.to,
    token: domain.verifyingContract,
    amount: message.value,
    network: terms.requirement.network,
    resource,
    warnings: resource === `${origin}${pathname}` ? [] : ['hidden_characters'],
    validUntil: new Date(Number(message.validBefore) * 1000).toISOString(),
  };
}

export function previewHash(preview: Preview): Hex {
  const canonical = Object.fromEntries(Object.entries(preview).sort(([a], [b]) => (a < b ? -1 : 1)));
  return keccak256(stringToHex(JSON.stringify(canonical)));
}

export function toPageView(request: ApprovalRequest): ApprovalPageView {
  const preview = previewOf(request);
  return {
    id: request.id,
    status: request.state.status,
    account: request.account,
    chainId: request.chainId,
    expiresAt: request.expiresAt.toISOString(),
    preview,
    previewHash: previewHash(preview),
    approve: signedPayload(request, 'approved'),
    reject: signedPayload(request, 'rejected'),
  };
}
