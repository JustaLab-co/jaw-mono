'use client';

import { standardErrorCodes, type Account, type WalletGrantPermissionsResponse } from '@jaw.id/core';
import { PortalContainerContext } from '@jaw.id/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import { postDecision, type ApprovalView, type BudgetView } from '../../lib/approval-decision';
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
function UiScope({ children }: { children: ReactNode }) {
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
      if (view.replaces) setDecided(answer);
      else onDecided(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The approval could not be sent.');
    } finally {
      setPosting(false);
    }
  };

  const revoke = useMemo<PermissionRequestData | null>(
    () =>
      view.replaces
        ? { method: 'wallet_revokePermissions', params: [{ id: view.replaces.permissionId, address: view.account }] }
        : null,
    [view.replaces, view.account]
  );

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
        {decided && revoke && (
          <>
            <p className="text-sm">
              Budget granted. Now revoke the budget it replaces, so only the new one stays live.
            </p>
            <PermissionModal
              permissionRequest={revoke}
              chain={chain}
              apiKey={apiKey ?? ''}
              account={account}
              onSuccess={() => onDecided(decided)}
              onError={() => onDecided(decided)}
            />
          </>
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
