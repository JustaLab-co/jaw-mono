import { connectionsSignInTypedData } from '@jaw.id/agent/reserved';
import type { Address, Hex } from 'viem';
import type { ClientIdentity } from '../components/ClientHeader';

export interface ConnectionView {
  id: string;
  status: 'active' | 'revoked';
  chainId: number;
  client: ClientIdentity;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  payer: Address | null;
  /** USDC base units in the payer, null when the server could not read it. */
  float: string | null;
  budgets: {
    permissionId: Hex;
    allowance: string;
    period: string;
    expiresAt: string;
    state: 'active' | 'revoke_on_chain' | 'revoked' | 'expired';
  }[];
  events: { tool: string; outcome: string; requestId: string | null; at: string }[];
}

export interface SignInProof {
  account: Address;
  chainId: number;
  expires: string;
  signature: string;
}

const SIGN_IN_MS = 10 * 60_000;

/** The server checks this signature on every request; it is kept in memory only. */
export async function signIn(
  signer: { signTypedData: (typedData: ReturnType<typeof connectionsSignInTypedData>) => Promise<string> },
  account: Address,
  { issuer, chainId }: { issuer: string; chainId: number }
): Promise<SignInProof> {
  const expires = new Date(Date.now() + SIGN_IN_MS).toISOString();
  const signature = await signer.signTypedData(connectionsSignInTypedData(chainId, { issuer, expires }));
  return { account, chainId, expires, signature };
}

const REFUSALS: Record<string, string> = {
  invalid_request: 'Your sign-in expired. Sign in again.',
  bad_signature: 'The sign-in did not verify for this account.',
  not_found: 'This connection does not exist.',
  verification_unavailable: 'The sign-in could not be checked right now. Try again in a moment.',
};

export class SignInExpired extends Error {}

export async function postProof<T>(url: string, proof: SignInProof): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proof),
  });
  const body = await res.json();
  if (res.ok) return body;
  const message = REFUSALS[body.error] ?? 'The server refused this request.';
  throw body.error === 'invalid_request' ? new SignInExpired(message) : new Error(message);
}
