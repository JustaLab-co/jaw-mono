import {
  hashMessage,
  hashTypedData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import { clientIdentity, type ClientIdentity } from './client-identity.js';
import { rejectionTypedData, RESERVED_PREFIX } from './reserved.js';

/** 16 random bytes, base64url. Unguessable: it is the read capability for the approval page. */
export type ApprovalId = string & { readonly __brand: 'ApprovalId' };

export const APPROVAL_TTL_MS = 10 * 60_000;
export const MAX_MESSAGE_CHARS = 4096;

/** What the agent asked for. */
export type ApprovalBody = { kind: 'signature'; message: string };

/** Exactly what the wallet signs. Derived from the body, never stored apart from it. */
export type SignedPayload =
  | { type: 'message'; message: string }
  | { type: 'typed_data'; typedData: TypedDataDefinition };

export interface DecisionEvidence {
  /** keccak256 of the preview the page rendered. */
  previewHash: Hex;
  /** EIP-191 or EIP-712 hash of the payload the signature covers. */
  payloadHash: Hex;
  /** Verified for the request's account on its chain. Carries the WebAuthn assertion. */
  signature: Hex;
  /** keccak256 of the signature: a stable reference to the passkey assertion inside it. */
  assertionRef: Hex;
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

/** Built on the server and rendered verbatim by the page. */
export interface Preview {
  kind: 'signature';
  requester: ClientIdentity;
  account: Address;
  chainId: number;
  /** The message with control, bidi and zero-width characters shown as ⟦U+XXXX⟧. */
  text: string;
  warnings: PreviewWarning[];
}

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

export type MessageRefusal = 'empty' | 'too_long' | 'reserved_prefix';

export function validateMessage(message: string): MessageRefusal | undefined {
  if (message.length === 0) return 'empty';
  if (message.length > MAX_MESSAGE_CHARS) return 'too_long';
  if (message.startsWith(RESERVED_PREFIX)) return 'reserved_prefix';
  return undefined;
}

export function openRequest(
  input: Pick<ApprovalRequest, 'id' | 'account' | 'chainId' | 'requester' | 'body'>,
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

export function signedPayload(request: ApprovalRequest, verdict: Verdict): SignedPayload {
  if (verdict === 'rejected') return { type: 'typed_data', typedData: rejectionTypedData(request.chainId, request.id) };
  switch (request.body.kind) {
    case 'signature':
      return { type: 'message', message: request.body.message };
  }
}

export function payloadHash(payload: SignedPayload): Hex {
  return payload.type === 'message' ? hashMessage(payload.message) : hashTypedData(payload.typedData);
}

// Every control, format (bidi, zero-width, tags), line and paragraph separator
// except newline and tab, plus every default-ignorable code point (variation
// selectors, the grapheme joiner, Hangul fillers) and the blank braille pattern.
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu;

const codePoint = (c: string) => `⟦U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}⟧`;

export function previewOf(request: ApprovalRequest): Preview {
  const { message } = request.body;
  const text = message.replace(HIDDEN, codePoint);
  const warnings: PreviewWarning[] = [];
  if (text !== message) warnings.push('hidden_characters');
  if (/0x[0-9a-fA-F]{40}/.test(message)) warnings.push('address_like');
  if (/<[a-zA-Z!/]/.test(message)) warnings.push('markup_like');
  return {
    kind: request.body.kind,
    requester: clientIdentity(request.requester.clientId, request.requester.name),
    account: request.account,
    chainId: request.chainId,
    text,
    warnings,
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
