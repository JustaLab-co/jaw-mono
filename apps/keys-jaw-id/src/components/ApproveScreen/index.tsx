'use client';

import { Account, jawPaymasterUrl } from '@jaw.id/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isAddressEqual, type Hex } from 'viem';
import {
  isBudget,
  isCalls,
  isPayment,
  postDecision,
  type ApprovalStatus,
  type ApprovalView,
  type CallsView,
  type PaymentView,
  type SignedPayload,
  type TransferView,
} from '../../lib/approval-decision';
import { fetchCliApiKey } from '../../lib/cli-api-key';
import { BudgetApproval, BudgetTerms, RevokeBudgets } from '../BudgetApproval';
import { CallsTerms } from '../CallsTerms';
import { ClientHeader } from '../ClientHeader';
import { PaymentTerms } from '../PaymentTerms';
import { SiweTerms } from '../SiweTerms';
import { TransferTerms } from '../TransferTerms';
import { TypedDataTerms } from '../TypedDataTerms';
import { SignInScreen, type AuthenticatedAccount } from '../OnboardingSection';
import type { ChainId } from '../../utils/types';

const WARNINGS: Record<string, string> = {
  hidden_characters: 'This message contains hidden or direction-changing characters, shown as ⟦U+…⟧.',
  address_like: 'This message contains an address. Check it against where it came from.',
  markup_like: 'This message contains markup. It is shown as plain text.',
};

const TITLES: Record<ApprovalView['preview']['kind'], string> = {
  signature: 'Signature request from',
  budget: 'Budget request from',
  payment: 'Payment request from',
  transfer: 'Transfer request from',
  calls: 'Transaction request from',
  'typed-data': 'Typed data request from',
  siwe: 'Sign-in request from',
};

// The name is whatever the client declared; its id (a URL for most clients) is what can be checked.

const DONE: Record<Exclude<ApprovalStatus, 'pending'>, string> = {
  approved: 'Approved. You can close this tab.',
  rejected: 'Rejected. You can close this tab.',
  expired: 'This request expired. Ask the agent to request it again.',
};

/** What an approved payment came to, from the decision's answer. */
function paidOutcome(payment: NonNullable<PaymentView['payment']>) {
  if (payment.kind === 'paid') return 'Paid. You can close this tab.';
  if (payment.code === 'price_changed') return 'Approved, but the price changed before paying. Nothing was sent.';
  if (payment.state === 'failed') return `Approved, but it was not paid (${payment.code}). Nothing was sent.`;
  return 'Approved. The payment is on its way; the agent will see how it ends.';
}

/** The server's preview for each kind, rendered as served. */
function Terms({ view }: { view: ApprovalView }) {
  switch (view.preview.kind) {
    case 'budget':
      return (
        <div>
          <BudgetTerms preview={view.preview} />
        </div>
      );
    case 'payment':
      return (
        <div>
          <PaymentTerms preview={view.preview} />
        </div>
      );
    case 'transfer':
      return (
        <div>
          <TransferTerms preview={view.preview} />
        </div>
      );
    case 'calls':
      return (
        <div className="flex flex-col gap-2">
          <CallsTerms preview={view.preview} />
        </div>
      );
    case 'typed-data':
      return (
        <div className="flex flex-col gap-2">
          <TypedDataTerms preview={view.preview} />
        </div>
      );
    case 'siwe':
      return (
        <div className="flex flex-col gap-1">
          <SiweTerms preview={view.preview} />
        </div>
      );
    case 'signature':
      return (
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
      );
  }
}

export function ApproveScreen({ id, mcpUrl }: { id: string; mcpUrl: string }) {
  const [account, setAccount] = useState<AuthenticatedAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [granter, setGranter] = useState<Account | null>(null);
  // Once the calls are sent, approving again only re-posts their id: sending twice would pay twice.
  const [sent, setSent] = useState<Hex | null>(null);
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
  if (view.status !== 'pending') {
    const done = isPayment(view) && view.payment ? paidOutcome(view.payment) : DONE[view.status];
    return <p className="text-center text-sm">{done}</p>;
  }

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

  // The served calls and paymaster context go to the wallet unchanged.
  const send = ({ approve, paymaster }: TransferView | CallsView) =>
    run(async () => {
      let callsId = sent;
      if (!callsId) {
        const signer = await Account.get({ chainId: view.chainId, apiKey });
        callsId = (await signer.sendCalls(approve.calls, undefined, jawPaymasterUrl(view.chainId, apiKey), paymaster))
          .id;
        setSent(callsId);
      }
      show(await postDecision(decisionUrl, { verdict: 'approved', callsId, previewHash: view.previewHash }));
    });

  const approve = () => {
    if (isBudget(view)) return run(async () => setGranter(await Account.get({ chainId: view.chainId, apiKey })));
    if (isCalls(view)) return send(view);
    return sign('approved', view.approve);
  };

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
        <ClientHeader title={TITLES[view.preview.kind]} client={view.preview.requester} />
        <p className="text-muted-foreground text-sm">
          For <span className="font-mono">{view.account}</span> on chain {view.chainId}
        </p>
        <p className="text-muted-foreground text-xs">Expires {new Date(view.expiresAt).toLocaleTimeString()}</p>
      </div>
      <Terms view={view} />
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
            {sent ? 'Check again' : 'Approve'}
          </button>
          <button
            className="flex-1 rounded border p-2 disabled:opacity-50"
            disabled={busy || sent !== null}
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
