import type { rejectionTypedData } from '@jaw.id/agent/reserved';
import type { WalletGrantPermissionsResponse } from '@jaw.id/core';
import type { Address, Hex } from 'viem';
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
}

export type ApprovalView = SignatureView | BudgetView;

/** What the page signs: the approved message, or the reserved rejection typed data. */
export type SignedPayload = SignatureView['approve'] | ViewBase['reject'];

export const isBudget = (view: ApprovalView): view is BudgetView => view.preview.kind === 'budget';

type Decision = { verdict: 'approved' | 'rejected'; previewHash: Hex } & (
  | { signature: string }
  | { permission: WalletGrantPermissionsResponse }
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
};

const GRANT_TRIES = 3;
const GRANT_RETRY_MS = 2000;

export async function postDecision(url: string, decision: Decision): Promise<ApprovalView> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision),
    });
    const body = await res.json();
    if (res.ok || body.status) return body;
    if (body.error !== 'grant_not_found' || attempt === GRANT_TRIES) {
      throw new Error(REFUSALS[body.error] ?? 'The server refused this decision.');
    }
    await new Promise((resolve) => setTimeout(resolve, GRANT_RETRY_MS));
  }
}
