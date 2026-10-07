import {
  hashMessage,
  isAddressEqual,
  keccak256,
  numberToHex,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import type { GrantedPermission } from '../session/session-config.js';
import { clientIdentity, type ClientIdentity } from './client-identity.js';

/** 16 random bytes, base64url. Unguessable: it is the read capability for the approval page. */
export type ApprovalId = string & { readonly __brand: 'ApprovalId' };

export const APPROVAL_TTL_MS = 10 * 60_000;
export const MAX_MESSAGE_CHARS = 4096;

/** Messages starting with this are reserved for JAW's own statements, such as connection consent. */
export const RESERVED_PREFIX = 'JAW ';

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

/** What the agent asked for. */
export type ApprovalBody = { kind: 'signature'; message: string } | BudgetBody;

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
  /** The session sends every refill and pays its gas, so its first one rides along with the grant. */
  capabilities: { prefundSpender: true };
}

/** Exactly what the wallet signs or sends. Derived from the body, never stored apart from it. */
export type SignedPayload = { type: 'message'; message: string } | { type: 'grant'; grant: GrantRequest };

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

export type MessageRefusal = 'empty' | 'too_long' | 'reserved_prefix';

export function validateMessage(message: string): MessageRefusal | undefined {
  if (message.length === 0) return 'empty';
  if (message.length > MAX_MESSAGE_CHARS) return 'too_long';
  if (message.startsWith(RESERVED_PREFIX)) return 'reserved_prefix';
  return undefined;
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

/** A reject is signed too, so only the account can move its own request. */
export function rejectionMessage(id: ApprovalId): string {
  return `${RESERVED_PREFIX}approval request ${id}: reject`;
}

/** Refuses a budget for any spender but the connection's own session key. */
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
  if (verdict === 'rejected') return { type: 'message', message: rejectionMessage(request.id) };
  const { body } = request;
  switch (body.kind) {
    case 'signature':
      return { type: 'message', message: body.message };
    case 'budget':
      return { type: 'grant', grant: grantOf({ ...request, body }) };
  }
}

export function payloadHash(payload: SignedPayload): Hex {
  if (payload.type === 'message') return hashMessage(payload.message);
  return keccak256(stringToHex(JSON.stringify(payload.grant)));
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
  const text = body.message.replace(HIDDEN, codePoint);
  const warnings: PreviewWarning[] = [];
  if (text !== body.message) warnings.push('hidden_characters');
  if (/0x[0-9a-fA-F]{40}/.test(body.message)) warnings.push('address_like');
  if (/<[a-zA-Z!/]/.test(body.message)) warnings.push('markup_like');
  return { kind: 'signature', ...base, text, warnings };
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
