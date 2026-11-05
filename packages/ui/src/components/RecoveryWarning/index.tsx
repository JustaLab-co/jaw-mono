'use client';

import type { CeremonyListEntry } from '@jaw.id/core';
import { Button } from '../ui/button';
import { RecoveryNotice } from '../RecoveryDialog/Sections';
import { formatRecoveryOpenedAt } from '../../utils/recoveryRequest';

export interface RecoveryWarningProps {
  /** The account's newest request that can still complete (`usePendingRecoveries`). */
  request: Pick<CeremonyListEntry, 'createdAt'>;
  /** The account's name, else its short address. */
  accountName: string;
  /** "Review and cancel": the cancel screen for `request`. */
  onReview: () => void;
}

/**
 * The owner's warning while someone is recovering the account: shown where the owner signs in, so
 * a request they did not start is seen the next time they open an app. There are no alerts beyond
 * this one in V1.
 */
export function RecoveryWarning({ request, accountName, onReview }: RecoveryWarningProps) {
  return (
    <div role="alert">
      <RecoveryNotice
        tone="destructive"
        title="Someone is recovering this account"
        action={
          <Button
            variant="destructive"
            onClick={onReview}
            className="rounded-box text-button h-11 px-4 font-semibold focus-visible:ring-1"
          >
            Review and cancel
          </Button>
        }
      >
        A new passkey was requested for {accountName} {formatRecoveryOpenedAt(request.createdAt)}. If it wasn’t you,
        cancel it. Nothing changes unless your guardians approve.
      </RecoveryNotice>
    </div>
  );
}
