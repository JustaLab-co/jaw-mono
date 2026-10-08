import {
  bytesToHex,
  encodeFunctionData,
  erc20Abi,
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
  validateTypedData,
} from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import type { GrantedPermission } from '../session/session-config.js';
import type { Challenge } from '../x402/http.js';
import { exactDraft, SETTLEMENT_WINDOW_FLOOR, type ExactDraft } from '../x402/scheme-exact-evm.js';
import type { X402PaymentRequirement } from '../x402/types.js';
import { clientIdentity, type ClientIdentity } from './client-identity.js';
import { rejectionTypedData, RESERVED_PREFIX, reservedSigningRefusal } from './reserved.js';

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

/** EIP-712 typed data as an agent sends it: JSON, any types. */
export type AgentTypedData = TypedDataDefinition<Record<string, unknown>, string>;

/** One call as `wallet_sendCalls` takes it. */
export interface Call {
  to: Address;
  data: Hex;
  /** Wei, hex. */
  value: Hex;
}

/** The ERC-20 paymaster's quote for the calls, in USDC base units, taken when the request was made. */
export interface GasQuote {
  /** What the fee is expected to come to. */
  estimate: string;
  /** Built by `buildErc20PaymasterContext`: the fee token, and the ceiling the paymaster is approved for. */
  context: { token: Address; gas: string };
}

/** USDC from the account to one recipient. */
export interface TransferBody {
  kind: 'transfer';
  to: Address;
  /** The ENS name the agent gave, resolved on the server to `to`. */
  name?: string;
  token: Address;
  /** Base units. */
  amount: string;
  gas: GasQuote;
}

export interface CallsBody {
  kind: 'calls';
  calls: Call[];
  gas: GasQuote;
}

/** What the agent asked for. */
export type ApprovalBody =
  | { kind: 'signature'; message: string }
  | { kind: 'siwe'; message: string }
  | { kind: 'typed-data'; typedData: AgentTypedData }
  | BudgetBody
  | PaymentBody
  | TransferBody
  | CallsBody;

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
  | { type: 'typed_data'; typedData: AgentTypedData }
  | { type: 'grant'; grant: GrantRequest }
  | { type: 'calls'; calls: Call[]; chainId: Hex };

/** How the account proved its decision: a signature, a permission now approved on chain, or calls it ran. */
export type DecisionProof =
  | {
      type: 'signature';
      /** Verified for the request's account on its chain. Carries the WebAuthn assertion. */
      signature: Hex;
      /** keccak256 of the signature: a stable reference to the passkey assertion inside it. */
      assertionRef: Hex;
    }
  | { type: 'permission'; permissionId: Hex }
  | {
      type: 'calls';
      /** The userOp hash `wallet_sendCalls` answered with. */
      callsId: Hex;
      txHash: Hex;
    };

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

export type CallWarning =
  | { code: 'unknown_function' }
  | { code: 'short_calldata' }
  | { code: 'token_approval'; spender: Address; amount: string; unlimited: boolean };

/** One call as the page shows it: the raw call always, its decoding when an ABI matched. */
export interface CallPreview extends Call {
  /** The function signature, such as `transfer(address,uint256)`. */
  function?: string;
  args?: { name: string; type: string; value: string }[];
  warnings: CallWarning[];
}

/** Decodes a call for its preview. The server's decoder lives with the server. */
export type DescribeCall = (call: Call) => CallPreview;

/** Base units of USDC. `max` is the ceiling the paymaster may charge. */
export interface GasPreview {
  token: Address;
  estimate: string;
  max: string;
}

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
    })
  | (PreviewBase & {
      kind: 'transfer';
      to: Address;
      name?: string;
      token: Address;
      /** Base units. */
      amount: string;
      gas: GasPreview;
    })
  | (PreviewBase & { kind: 'calls'; calls: CallPreview[]; gas: GasPreview })
  | (PreviewBase & {
      kind: 'typed-data';
      /** Domain and message as JSON, hidden characters shown as ⟦U+XXXX⟧. */
      domain: string;
      primaryType: string;
      message: string;
      warnings: ('hidden_characters' | 'token_permit' | 'chain_mismatch')[];
    })
  | (PreviewBase & {
      kind: 'siwe';
      domain: string;
      uri: string;
      statement: string | null;
      nonce: string;
      issuedAt: string;
      expirationTime: string | null;
      /** `siwe_login` always: the signature logs the agent into `domain` as the account. */
      warnings: ('siwe_login' | 'hidden_characters')[];
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
  /** For transfers and calls: the ERC-20 paymaster context the page sends them with. */
  paymaster?: GasQuote['context'];
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

export type SiweRefusal = 'siwe_account' | 'siwe_chain';

/**
 * The body for a message to sign: a Sign in with Ethereum login when it parses
 * as EIP-4361, which must name this account and chain, else a plain signature.
 */
export function messageBody(
  message: string,
  account: Address,
  chainId: number
): ApprovalBody | MessageRefusal | SiweRefusal {
  const refused = validateMessage(message);
  if (refused) return refused;
  const siwe = siweFields(message);
  if (!siwe) return { kind: 'signature', message };
  if (!isAddressEqual(siwe.address, account)) return 'siwe_account';
  if (siwe.chainId !== chainId) return 'siwe_chain';
  return { kind: 'siwe', message };
}

function siweFields(message: string) {
  const { address, chainId, domain, uri, version, nonce, issuedAt, statement, expirationTime } =
    parseSiweMessage(message);
  if (!address || !chainId || !domain || !uri || !version || !nonce || !issuedAt) return undefined;
  if (Number.isNaN(issuedAt.getTime()) || (expirationTime && Number.isNaN(expirationTime.getTime()))) return undefined;
  return { address, chainId, domain, uri, nonce, issuedAt, statement, expirationTime };
}

export const MAX_TYPED_DATA_CHARS = 16_384;

export type TypedDataRefusal = 'reserved_domain' | 'invalid' | 'too_long' | 'unstorable';

/** Why the agent's typed data cannot be asked for, or undefined when it can. */
export function typedDataRefusal(typedData: AgentTypedData, account: Address): TypedDataRefusal | undefined {
  if (reservedSigningRefusal('eth_signTypedData_v4', [account, typedData])) return 'reserved_domain';
  try {
    validateTypedData(typedData);
    hashTypedData(typedData);
  } catch {
    return 'invalid';
  }
  if (JSON.stringify(typedData).length > MAX_TYPED_DATA_CHARS) return 'too_long';
  if (unstorable(typedData)) return 'unstorable';
  return undefined;
}

const unstorable = (value: unknown): boolean => {
  if (typeof value === 'string') return hasUnstorableText(value);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, v]) => hasUnstorableText(key) || unstorable(v));
};

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
    case 'siwe':
      return { type: 'message', message: body.message };
    case 'typed-data':
      return { type: 'typed_data', typedData: body.typedData };
    case 'transfer':
    case 'calls':
      return { type: 'calls', calls: callsOf(body), chainId: numberToHex(request.chainId) };
  }
}

const callsOf = (body: TransferBody | CallsBody): Call[] =>
  body.kind === 'calls' ? body.calls : [transferCall(body.token, body.to, body.amount)];

/** The ERC-20 transfer a transfer body sends. */
export function transferCall(token: Address, to: Address, amount: string): Call {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, BigInt(amount)] });
  return { to: token, value: '0x0', data };
}

// JAW's ERC-20 paymaster, mirrored from core's ERC20_PAYMASTER_ADDRESS, which
// core does not export. The page's send approves it for the quoted ceiling.
const ERC20_PAYMASTER: Address = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';

/**
 * Whether a userOp ran exactly the signed calls, byte for byte. The send puts
 * the paymaster's approve for the quoted ceiling in front when the account's
 * allowance is short, so that one call, exactly, may lead.
 */
export function executedAsSigned(
  signed: readonly Call[],
  gas: GasQuote,
  executed: readonly { to: Address; value: bigint; data: Hex }[]
): boolean {
  const { token, gas: ceiling } = gas.context;
  const approve: Call = {
    to: token,
    value: '0x0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ERC20_PAYMASTER, BigInt(ceiling)] }),
  };
  const expected = executed.length === signed.length + 1 ? [approve, ...signed] : signed;
  return (
    expected.length === executed.length &&
    expected.every(
      (call, i) =>
        isAddressEqual(call.to, executed[i].to) &&
        BigInt(call.value) === executed[i].value &&
        call.data.toLowerCase() === executed[i].data.toLowerCase()
    )
  );
}

export function payloadHash(payload: SignedPayload): Hex {
  switch (payload.type) {
    case 'message':
      return hashMessage(payload.message);
    case 'typed_data':
      return hashTypedData(payload.typedData);
    case 'grant':
      return keccak256(stringToHex(JSON.stringify(payload.grant)));
    case 'calls':
      return keccak256(stringToHex(JSON.stringify({ calls: payload.calls, chainId: payload.chainId })));
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

export function previewOf(request: ApprovalRequest, describeCall: DescribeCall): Preview {
  const base = {
    requester: clientIdentity(request.requester.clientId, request.requester.name),
    account: request.account,
    chainId: request.chainId,
  };
  const { body } = request;
  switch (body.kind) {
    case 'budget': {
      const { spender, token, allowance, expiry } = budgetOf({ ...request, body });
      const expiresAt = new Date(expiry * 1000).toISOString();
      return { kind: 'budget', ...base, spender, token, allowance, period: 'day', expiresAt };
    }
    case 'payment':
      return previewOfPayment(base, body.terms);
    case 'transfer': {
      const { to, name, token, amount, gas } = body;
      return { kind: 'transfer', ...base, to, ...(name && { name }), token, amount, gas: gasPreview(gas) };
    }
    case 'calls':
      return { kind: 'calls', ...base, calls: body.calls.map(describeCall), gas: gasPreview(body.gas) };
    case 'typed-data':
      return previewOfTypedData(base, body.typedData);
    case 'siwe':
      return previewOfSiwe(base, body.message);
    case 'signature': {
      const text = shown(body.message);
      const warnings: PreviewWarning[] = [];
      if (text !== body.message) warnings.push('hidden_characters');
      if (/0x[0-9a-fA-F]{40}/.test(body.message)) warnings.push('address_like');
      if (/<[a-zA-Z!/]/.test(body.message)) warnings.push('markup_like');
      return { kind: 'signature', ...base, text, warnings };
    }
  }
}

const shown = (text: string) => text.replace(HIDDEN, codePoint);

const gasPreview = ({ estimate, context }: GasQuote): GasPreview => ({
  token: context.token,
  estimate,
  max: context.gas,
});

const TOKEN_MOVERS = new Set([
  'Permit',
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'TransferWithAuthorization',
  'ReceiveWithAuthorization',
]);

function previewOfTypedData(base: PreviewBase, typedData: AgentTypedData): Preview {
  const domain = JSON.stringify(typedData.domain ?? {}, null, 2);
  const message = JSON.stringify(typedData.message, null, 2);
  const warnings: ('hidden_characters' | 'token_permit' | 'chain_mismatch')[] = [];
  if (shown(domain + typedData.primaryType + message) !== domain + typedData.primaryType + message) {
    warnings.push('hidden_characters');
  }
  if (TOKEN_MOVERS.has(typedData.primaryType)) warnings.push('token_permit');
  const chainId = typedData.domain?.chainId;
  if (chainId !== undefined && Number(chainId) !== base.chainId) warnings.push('chain_mismatch');
  return {
    kind: 'typed-data',
    ...base,
    domain: shown(domain),
    primaryType: shown(typedData.primaryType),
    message: shown(message),
    warnings,
  };
}

// The body was checked as EIP-4361 when it was stored, so every field read here is present.
function previewOfSiwe(base: PreviewBase, message: string): Preview {
  const fields = siweFields(message);
  if (!fields) throw new Error('stored login message does not parse as EIP-4361');
  return {
    kind: 'siwe',
    ...base,
    domain: shown(fields.domain),
    uri: shown(fields.uri),
    statement: fields.statement === undefined ? null : shown(fields.statement),
    nonce: shown(fields.nonce),
    issuedAt: fields.issuedAt.toISOString(),
    expirationTime: fields.expirationTime?.toISOString() ?? null,
    warnings: shown(message) === message ? ['siwe_login'] : ['siwe_login', 'hidden_characters'],
  };
}

// Read from the typed data the owner signs, and from the terms alone: nothing
// else on a request can reach the page through it.
function previewOfPayment(base: PreviewBase, terms: PaymentTerms): Preview {
  const { domain, message } = paymentDraft(base.account, terms).typedData;
  const { origin, pathname } = new URL(terms.resource);
  const resource = shown(`${origin}${pathname}`);
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

export function toPageView(request: ApprovalRequest, describeCall: DescribeCall): ApprovalPageView {
  const preview = previewOf(request, describeCall);
  const { body } = request;
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
    ...((body.kind === 'transfer' || body.kind === 'calls') && { paymaster: body.gas.context }),
  };
}
