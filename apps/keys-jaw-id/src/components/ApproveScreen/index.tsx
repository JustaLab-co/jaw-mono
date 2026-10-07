'use client';

import { Account } from '@jaw.id/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isAddressEqual, type Address } from 'viem';
import { fetchCliApiKey } from '../../lib/cli-api-key';
import { ClientHeader, type ClientIdentity } from '../ClientHeader';
import { SignInScreen, type AuthenticatedAccount } from '../OnboardingSection';
import type { ChainId } from '../../utils/types';

type Status = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalView {
  id: string;
  status: Status;
  account: Address;
  chainId: number;
  expiresAt: string;
  preview: {
    kind: 'signature';
    requester: ClientIdentity;
    text: string;
    warnings: string[];
  };
  previewHash: `0x${string}`;
  approve: { type: 'message'; message: string };
  reject: { type: 'message'; message: string };
}

const WARNINGS: Record<string, string> = {
  hidden_characters: 'This message contains hidden or direction-changing characters, shown as ⟦U+…⟧.',
  address_like: 'This message contains an address. Check it against where it came from.',
  markup_like: 'This message contains markup. It is shown as plain text.',
};

// The name is whatever the client declared; its id (a URL for most clients) is what can be checked.

const DONE: Record<Exclude<Status, 'pending'>, string> = {
  approved: 'Approved. You can close this tab.',
  rejected: 'Rejected. You can close this tab.',
  expired: 'This request expired. Ask the agent to request it again.',
};

export function ApproveScreen({ id, mcpUrl }: { id: string; mcpUrl: string }) {
  const [account, setAccount] = useState<AuthenticatedAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const url = `${mcpUrl}/api/approvals/${encodeURIComponent(id)}`;

  const query = useQuery({
    queryKey: ['approval', id],
    retry: false,
    queryFn: async (): Promise<{ view: ApprovalView; apiKey?: string }> => {
      const [res, apiKey] = await Promise.all([fetch(url, { cache: 'no-store' }), fetchCliApiKey()]);
      if (!res.ok) throw new Error('not_found');
      return { view: await res.json(), apiKey: apiKey || undefined };
    },
  });

  if (query.isPending) return <p className="text-center text-sm">Loading…</p>;
  if (query.isError) return <p className="text-center text-sm">This request does not exist.</p>;
  const { view, apiKey } = query.data;
  if (view.status !== 'pending') return <p className="text-center text-sm">{DONE[view.status]}</p>;

  const wrongAccount = account !== null && !isAddressEqual(account.address, view.account);

  const decide = async (verdict: 'approved' | 'rejected') => {
    setBusy(true);
    setError('');
    try {
      const payload = verdict === 'approved' ? view.approve : view.reject;
      const signer = await Account.get({ chainId: view.chainId, apiKey });
      const signature = await signer.signMessage(payload.message);
      const res = await fetch(`${url}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict, signature, previewHash: view.previewHash }),
      });
      const body = await res.json();
      if (!res.ok && !body.status) throw new Error(REFUSALS[body.error] ?? 'The server refused this decision.');
      queryClient.setQueryData(['approval', id], { view: body as ApprovalView, apiKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signing failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-6">
      <div>
        <ClientHeader title="Signature request from" client={view.preview.requester} />
        <p className="text-muted-foreground text-sm">
          For <span className="font-mono">{view.account}</span> on chain {view.chainId}
        </p>
        <p className="text-muted-foreground text-xs">Expires {new Date(view.expiresAt).toLocaleTimeString()}</p>
      </div>
      {view.preview.warnings.map((w) => (
        <p key={w} className="text-destructive text-sm">
          {WARNINGS[w] ?? w}
        </p>
      ))}
      <div>
        <p className="text-muted-foreground mb-1 text-xs">Message</p>
        <pre data-testid="approval-message" className="bg-muted whitespace-pre-wrap break-all rounded p-3 text-xs">
          {view.preview.text}
        </pre>
      </div>
      {account === null ? (
        <SignInScreen chainId={view.chainId as ChainId} apiKey={apiKey} onComplete={setAccount} />
      ) : wrongAccount ? (
        <p className="text-destructive text-sm">
          This request is for <span className="font-mono">{view.account}</span>, and you are signed in as{' '}
          <span className="font-mono">{account.address}</span>.
        </p>
      ) : (
        <div className="flex gap-2">
          <button
            className="bg-primary text-primary-foreground flex-1 rounded p-2 disabled:opacity-50"
            disabled={busy}
            onClick={() => decide('approved')}
          >
            Approve
          </button>
          <button
            className="flex-1 rounded border p-2 disabled:opacity-50"
            disabled={busy}
            onClick={() => decide('rejected')}
          >
            Reject
          </button>
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

const REFUSALS: Record<string, string> = {
  bad_signature: 'The signature did not verify for this account.',
  preview_changed: 'The request changed while you were reading it. Reload the page.',
  not_found: 'This request does not exist.',
};
