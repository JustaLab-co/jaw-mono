'use client';

import { standardErrorCodes, type Account, type WalletGrantPermissionsResponse } from '@jaw.id/core';
import { PortalContainerContext } from '@jaw.id/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import { isBudget, postDecision, type ApprovalView, type BudgetView } from '../../lib/approval-decision';
import type { Hex } from 'viem';
import { ClientHeader } from '../ClientHeader';
import { PermissionModal, type PermissionRequestData } from '../PermissionModal';

export function BudgetTerms({ preview }: { preview: BudgetView['preview'] }) {
  return (
    <>
      <p className="text-sm">
        Up to <span className="font-semibold">{formatUnits(BigInt(preview.allowance), 6)} USDC</span> per day
      </p>
      <p className="text-muted-foreground text-sm">
        Spender: <span className="font-mono">{preview.spender}</span>
      </p>
      <p className="text-muted-foreground text-sm">Until {new Date(preview.expiresAt).toLocaleString()}</p>
    </>
  );
}

/** The JAW UI styles apply under `data-jaw-ui`, and the dialog portals into it rather than off to the body. */
export function UiScope({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot} data-jaw-ui className="contents">
      <PortalContainerContext.Provider value={root}>{children}</PortalContainerContext.Provider>
    </div>
  );
}

interface BudgetApprovalProps {
  view: BudgetView;
  account: Account;
  apiKey?: string;
  decisionUrl: string;
  onDecided: (view: ApprovalView) => void;
  onCancel: (message: string) => void;
}

export function BudgetApproval({ view, account, apiKey, decisionUrl, onDecided, onCancel }: BudgetApprovalProps) {
  const [granted, setGranted] = useState<WalletGrantPermissionsResponse | null>(null);
  const [decided, setDecided] = useState<ApprovalView | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const chain = useMemo(() => account.getChain(), [account]);
  const grant = view.approve.grant;
  const request = useMemo<PermissionRequestData>(
    () => ({ method: 'wallet_grantPermissions', params: [grant] }),
    [grant]
  );

  const submit = async (permission: WalletGrantPermissionsResponse) => {
    setGranted(permission);
    setPosting(true);
    setError('');
    try {
      const answer = await postDecision(decisionUrl, {
        verdict: 'approved',
        previewHash: view.previewHash,
        permission,
      });
      if (isBudget(answer) && answer.revoke?.length) setDecided(answer);
      else onDecided(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The approval could not be sent.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <UiScope>
      <div className="flex flex-col gap-4 rounded-lg border p-6">
        <div>
          <ClientHeader title="Budget request from" client={view.preview.requester} />
          <BudgetTerms preview={view.preview} />
        </div>
        {granted === null && (
          <PermissionModal
            permissionRequest={request}
            chain={chain}
            apiKey={apiKey ?? ''}
            account={account}
            onSuccess={(result) => 'permissionId' in result && submit(result)}
            onError={(err, code) =>
              onCancel(code === standardErrorCodes.provider.userRejectedRequest ? '' : err.message)
            }
          />
        )}
        {decided && isBudget(decided) && (
          <RevokeBudgets
            view={decided}
            account={account}
            apiKey={apiKey}
            viewUrl={viewUrlOf(decisionUrl)}
            onDone={onDecided}
          />
        )}
        {posting && <p className="text-sm">Saving your approval…</p>}
        {error && (
          <>
            <p className="text-destructive text-sm">{error}</p>
            <button className="rounded border p-2" onClick={() => granted && submit(granted)}>
              Try again
            </button>
          </>
        )}
      </div>
    </UiScope>
  );
}

const viewUrlOf = (decisionUrl: string) => decisionUrl.replace(/\/decision$/, '');

interface RevokeBudgetsProps {
  view: BudgetView;
  account: Account;
  apiKey?: string;
  viewUrl: string;
  onDone: (view: ApprovalView) => void;
}

/** Revokes the budgets the server lists as replaced and still live, one at a time, until the chain shows them gone. */
export function RevokeBudgets({ view, account, apiKey, viewUrl, onDone }: RevokeBudgetsProps) {
  const [outstanding, setOutstanding] = useState<Hex[]>(view.revoke ?? []);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState('');
  const chain = useMemo(() => account.getChain(), [account]);
  const request = useMemo<PermissionRequestData>(
    () => ({ method: 'wallet_revokePermissions', params: [{ id: outstanding[0], address: view.account }] }),
    [outstanding, view.account]
  );

  const revoked = async () => {
    setOpen(false);
    const fresh: ApprovalView = await (await fetch(viewUrl, { cache: 'no-store' })).json();
    const left = isBudget(fresh) ? (fresh.revoke ?? []) : [];
    if (left.length === 0) return onDone(fresh);
    setOutstanding(left);
    setError('The chain does not show the previous budget revoked yet, so it is still approved on chain.');
  };

  return (
    <UiScope>
      <div className="flex flex-col gap-2">
        <p className="text-sm">Revoke the budget this one replaced, so only the new one stays live.</p>
        {open && (
          <PermissionModal
            permissionRequest={request}
            chain={chain}
            apiKey={apiKey ?? ''}
            account={account}
            onSuccess={revoked}
            onError={() => {
              setOpen(false);
              setError('The budget this one replaced is still approved on chain.');
            }}
          />
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
        {!open && (
          <button className="rounded border p-2" onClick={() => setOpen(true)}>
            Retry revoke
          </button>
        )}
      </div>
    </UiScope>
  );
}
