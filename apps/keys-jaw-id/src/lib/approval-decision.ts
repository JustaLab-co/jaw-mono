import type { rejectionTypedData } from '@jaw.id/agent/reserved';
import type { WalletGrantPermissionsResponse } from '@jaw.id/core';
import type { Address, Hex, TypedDataDefinition } from 'viem';
import type { ClientIdentity } from '../components/ClientHeader';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface GrantRequest {
  address: Address;
  spender: Address;
  expiry: number;
  chainId: Hex;
  permissions: {
    calls: { target: Address; functionSignature: string }[];
    spends: { token: Address; allowance: string; unit: 'day'; multiplier: 1 }[];
  };
  capabilities: { prefundSpender: true };
}

interface ViewBase {
  id: string;
  status: ApprovalStatus;
  account: Address;
  chainId: number;
  expiresAt: string;
  previewHash: Hex;
  reject: { type: 'typed_data'; typedData: ReturnType<typeof rejectionTypedData> };
}

export interface SignatureView extends ViewBase {
  preview: { kind: 'signature'; requester: ClientIdentity; text: string; warnings: string[] };
  approve: { type: 'message'; message: string };
}

export interface BudgetView extends ViewBase {
  preview: {
    kind: 'budget';
    requester: ClientIdentity;
    account: Address;
    chainId: number;
    spender: Address;
    token: Address;
    allowance: string;
    period: 'day';
    expiresAt: string;
  };
  approve: { type: 'grant'; grant: GrantRequest };
  /** The budget this one replaces, revoked by the page once the new one is granted. */
  replaces?: { permissionId: Hex };
}

/** EIP-3009 TransferWithAuthorization from the account, under the token's own domain. Amounts are decimal strings. */
export interface TransferTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: { TransferWithAuthorization: { name: string; type: string }[] };
  primaryType: 'TransferWithAuthorization';
  message: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
}

export interface PaymentView extends ViewBase {
  preview: {
    kind: 'payment';
    requester: ClientIdentity;
    account: Address;
    chainId: number;
    payTo: Address;
    token: Address;
    /** Base units of USDC. */
    amount: string;
    network: string;
    resource: string;
    warnings: string[];
    validUntil: string;
  };
  approve: { type: 'typed_data'; typedData: TransferTypedData };
  /** What paying it came to, on the answer to an approval. No seller text. */
  payment?: { state: string; kind: string | null; code: string | null };
}

/** Base units of USDC. `max` is the most the paymaster may charge. */
export interface Gas {
  token: Address;
  estimate: string;
  max: string;
}

export interface Call {
  to: Address;
  data: Hex;
  /** Wei, hex. */
  value: Hex;
}

interface CallsBase extends ViewBase {
  approve: { type: 'calls'; calls: Call[]; chainId: Hex };
  /** The ERC-20 paymaster context the calls are sent with, as served. */
  paymaster: { token: Address; gas: string };
}

export interface TransferView extends CallsBase {
  preview: {
    kind: 'transfer';
    requester: ClientIdentity;
    to: Address;
    /** The ENS name the agent gave, resolved by the server to `to`. */
    name?: string;
    token: Address;
    /** Base units of USDC. */
    amount: string;
    gas: Gas;
  };
}

export type CallWarning =
  | { code: 'unknown_function' }
  | { code: 'short_calldata' }
  | { code: 'token_approval'; spender: Address; amount: string; unlimited: boolean };

export interface CallPreview extends Call {
  function?: string;
  args?: { name: string; type: string; value: string }[];
  warnings: CallWarning[];
}

export interface CallsView extends CallsBase {
  preview: { kind: 'calls'; requester: ClientIdentity; calls: CallPreview[]; gas: Gas };
}

export interface TypedDataView extends ViewBase {
  preview: {
    kind: 'typed-data';
    requester: ClientIdentity;
    domain: string;
    primaryType: string;
    message: string;
    warnings: string[];
  };
  approve: { type: 'typed_data'; typedData: TypedDataDefinition };
}

export interface SiweView extends ViewBase {
  preview: {
    kind: 'siwe';
    requester: ClientIdentity;
    account: Address;
    domain: string;
    uri: string;
    statement: string | null;
    nonce: string;
    issuedAt: string;
    expirationTime: string | null;
    warnings: string[];
  };
  approve: { type: 'message'; message: string };
}

export type ApprovalView =
  | SignatureView
  | BudgetView
  | PaymentView
  | TransferView
  | CallsView
  | TypedDataView
  | SiweView;

/** What the page signs: the approved message or typed data, or the reserved rejection typed data. */
export type SignedPayload =
  | SignatureView['approve']
  | PaymentView['approve']
  | TypedDataView['approve']
  | ViewBase['reject'];

export const isBudget = (view: ApprovalView): view is BudgetView => view.preview.kind === 'budget';
export const isPayment = (view: ApprovalView): view is PaymentView => view.preview.kind === 'payment';
export const isCalls = (view: ApprovalView): view is TransferView | CallsView =>
  view.preview.kind === 'transfer' || view.preview.kind === 'calls';

type Decision = { verdict: 'approved' | 'rejected'; previewHash: Hex } & (
  | { signature: string }
  | { permission: WalletGrantPermissionsResponse }
  | { callsId: Hex }
);

const REFUSALS: Record<string, string> = {
  bad_signature: 'The signature did not verify for this account.',
  preview_changed: 'The request changed while you were reading it. Reload the page.',
  not_found: 'This request does not exist.',
  unsupported_chain: 'This request is on a chain this server cannot check.',
  connection_revoked: 'The app that asked was disconnected, so this request can no longer be approved.',
  verification_unavailable: 'The signature could not be checked right now. Try again in a moment.',
  grant_mismatch: 'The permission your wallet returned does not match this request, so nothing was recorded.',
  grant_not_found: 'The permission does not show as granted on chain yet. Try again in a moment.',
  payments_paused: 'Payments are paused on this server, so nothing was paid. Try again later.',
  calls_mismatch: 'What ran on chain is not this request, or it reverted, so nothing was recorded.',
  calls_pending: 'The transaction is not on chain yet. The agent will not see it approved until it is.',
};

// How often each refusal that only means "not on chain yet" is retried, 2 s apart.
const TRIES: Record<string, number> = { grant_not_found: 3, calls_pending: 15 };
const RETRY_MS = 2000;

export async function postDecision(url: string, decision: Decision): Promise<ApprovalView> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision),
    });
    const body = await res.json();
    if (res.ok || body.status) return body;
    if (attempt >= (TRIES[body.error] ?? 1)) {
      throw new Error(REFUSALS[body.error] ?? 'The server refused this decision.');
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
