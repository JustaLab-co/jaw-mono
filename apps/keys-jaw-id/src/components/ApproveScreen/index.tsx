'use client';

import { Account } from '@jaw.id/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isAddressEqual } from 'viem';
import {
  isBudget,
  postDecision,
  type ApprovalStatus,
  type ApprovalView,
  type SignedPayload,
} from '../../lib/approval-decision';
import { fetchCliApiKey } from '../../lib/cli-api-key';
import { BudgetApproval, BudgetTerms, RevokeBudgets } from '../BudgetApproval';
import { ClientHeader } from '../ClientHeader';
import { SignInScreen, type AuthenticatedAccount } from '../OnboardingSection';
import type { ChainId } from '../../utils/types';

const WARNINGS: Record<string, string> = {
  hidden_characters: 'This message contains hidden or direction-changing characters, shown as ⟦U+…⟧.',
  address_like: 'This message contains an address. Check it against where it came from.',
  markup_like: 'This message contains markup. It is shown as plain text.',
};

// The name is whatever the client declared; its id (a URL for most clients) is what can be checked.

const DONE: Record<Exclude<ApprovalStatus, 'pending'>, string> = {
  approved: 'Approved. You can close this tab.',
  rejected: 'Rejected. You can close this tab.',
  expired: 'This request expired. Ask the agent to request it again.',
};

export function ApproveScreen({ id, mcpUrl }: { id: string; mcpUrl: string }) {
  const [account, setAccount] = useState<AuthenticatedAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [granter, setGranter] = useState<Account | null>(null);
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
  const show = (decided: ApprovalView) => queryClient.setQueryData(['approval', id], { view: decided, apiKey });
  if (isBudget(view) && view.status === 'approved' && view.revoke?.length) {
    if (granter) return <RevokeBudgets view={view} account={granter} apiKey={apiKey} viewUrl={url} onDone={show} />;
    return (
      <div className="flex flex-col gap-4 rounded-lg border p-6">
        <p className="text-sm">Approved. The budget this one replaced is still approved on chain.</p>
        {account === null ? (
          <SignInScreen chainId={view.chainId as ChainId} apiKey={apiKey} onComplete={setAccount} />
        ) : (
          <button
            className="rounded border p-2"
            onClick={async () => setGranter(await Account.get({ chainId: view.chainId, apiKey }))}
          >
            Retry revoke
          </button>
        )}
      </div>
    );
  }
  if (view.status !== 'pending') return <p className="text-center text-sm">{DONE[view.status]}</p>;

  const wrongAccount = account !== null && !isAddressEqual(account.address, view.account);
  const decisionUrl = `${url}/decision`;

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await step();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signing failed.');
    } finally {
      setBusy(false);
    }
  };

  const sign = (verdict: 'approved' | 'rejected', payload: SignedPayload) =>
    run(async () => {
      const signer = await Account.get({ chainId: view.chainId, apiKey });
      const signature =
        payload.type === 'message'
          ? await signer.signMessage(payload.message)
          : await signer.signTypedData(payload.typedData);
      show(await postDecision(decisionUrl, { verdict, signature, previewHash: view.previewHash }));
    });

  const approve = () =>
    isBudget(view)
      ? run(async () => setGranter(await Account.get({ chainId: view.chainId, apiKey })))
      : sign('approved', view.approve);

  if (granter && isBudget(view)) {
    return (
      <BudgetApproval
        view={view}
        account={granter}
        apiKey={apiKey}
        decisionUrl={decisionUrl}
        onDecided={show}
        onCancel={(message) => {
          setGranter(null);
          setError(message);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-6">
      <div>
        <ClientHeader
          title={isBudget(view) ? 'Budget request from' : 'Signature request from'}
          client={view.preview.requester}
        />
        <p className="text-muted-foreground text-sm">
          For <span className="font-mono">{view.account}</span> on chain {view.chainId}
        </p>
        <p className="text-muted-foreground text-xs">Expires {new Date(view.expiresAt).toLocaleTimeString()}</p>
      </div>
      {isBudget(view) ? (
        <div>
          <BudgetTerms preview={view.preview} />
        </div>
      ) : (
        <>
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
        </>
      )}
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
            onClick={approve}
          >
            Approve
          </button>
          <button
            className="flex-1 rounded border p-2 disabled:opacity-50"
            disabled={busy}
            onClick={() => sign('rejected', view.reject)}
          >
            Reject
          </button>
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
