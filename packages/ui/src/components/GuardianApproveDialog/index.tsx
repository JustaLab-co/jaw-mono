'use client';

import { useState } from 'react';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { ShellDialog } from '../ShellDialog';
import { ProcessingScreen } from '../ProcessingScreen';
import { DialogAppHeader } from '../DialogAppHeader';
import { AppAvatar } from '../AppAvatar';
import { RecoveryNotice } from '../RecoveryDialog/Sections';
import { RecoveryScreen } from '../RecoveryStartDialog/RecoveryScreen';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import {
  GuardianApproved,
  GuardianBlockNotice,
  GuardianChecks,
  GuardianRequestFacts,
  OpenRequestsNotice,
  useRecoveryName,
} from './GuardianApproval';
import type { GuardianApproveDialogProps } from './types';

/**
 * A guardian approving a recovery request from inside an app: the app's own dialog in
 * App-Specific mode, the keys popup in Cross-Platform. The app can't vouch for the request, so the
 * screen asks the guardian to confirm two things themselves before Approve turns on, and shows
 * the approval count only once they signed.
 *
 * What is signed is the request this screen shows: core rebuilds it from the same request id,
 * whose hash binds the account and the new passkey.
 */
export const GuardianApproveDialog = ({
  open,
  onOpenChange,
  origin,
  appName,
  appLogoUrl,
  mainnetRpcUrl,
  ceremony,
  failed,
  openRequests,
  guardian,
  block,
  onApprove,
  isApproving,
  approval,
  error,
  onCancel,
  onDone,
}: GuardianApproveDialogProps) => {
  const [contacted, setContacted] = useState(false);
  const [calm, setCalm] = useState(false);

  const { name: owner } = useRecoveryName(ceremony?.account, mainnetRpcUrl);
  const guardianIdentity = useReverseIdentity(guardian, 1, mainnetRpcUrl);
  const canApprove = !!ceremony && !block && contacted && calm && !isApproving;

  const renderReview = () => (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-6 pt-6">
        <DialogAppHeader appName={appName} appLogoUrl={appLogoUrl} origin={origin} />
        {ceremony && <h2 className="text-foreground text-title-xl mt-4">{`Approve ${owner}’s new passkey`}</h2>}
      </div>

      <RecoveryScreen
        className="pt-4"
        footer={
          block ? (
            <Button
              onClick={onCancel}
              className="rounded-box text-button h-11 w-full font-semibold focus-visible:ring-1"
            >
              Close
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              {/* The boxes can sit below the fold, so say why Approve is off. */}
              {ceremony && !(contacted && calm) && (
                <p className="text-muted-foreground text-body-sm text-center">Tick both boxes above to approve.</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={onCancel}
                  disabled={isApproving}
                  className="rounded-box text-button h-11 flex-[44] font-semibold focus-visible:ring-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={onApprove}
                  disabled={!canApprove}
                  className="rounded-box text-button h-11 flex-[56] font-semibold focus-visible:ring-1"
                >
                  Approve
                </Button>
              </div>
            </div>
          )
        }
      >
        {!ceremony ? (
          failed ? (
            <RecoveryNotice tone="destructive" title="This request couldn’t be loaded">
              Check your connection. This screen tries again on its own.
            </RecoveryNotice>
          ) : (
            <div className="flex min-h-[200px] items-center justify-center">
              <Spinner className="size-5" />
            </div>
          )
        ) : (
          <>
            <p className="text-muted-foreground text-body">
              {owner} lost their passkey and made a new one. You’re approving it as their guardian.
            </p>

            {/* First, before the facts: approving the wrong one of two open requests is the mistake to stop. */}
            {!block && openRequests && (
              <OpenRequestsNotice requests={openRequests} requestId={ceremony.requestId} owner={owner} />
            )}

            <GuardianRequestFacts ceremony={ceremony} guardian={guardian} mainnetRpcUrl={mainnetRpcUrl} />

            {block ? (
              <GuardianBlockNotice block={block} ceremony={ceremony} owner={owner} />
            ) : (
              <>
                <RecoveryNotice tone="warning" title="This app can’t vouch for the request">
                  Only {owner} can. Contact them yourself before you approve.
                </RecoveryNotice>
                <GuardianChecks
                  owner={owner}
                  contacted={contacted}
                  calm={calm}
                  onContactedChange={setContacted}
                  onCalmChange={setCalm}
                  disabled={isApproving}
                />
              </>
            )}

            {error && (
              <div className="bg-destructive/10 rounded-box p-3">
                <p className="text-destructive dark:text-negative text-body">{error}</p>
              </div>
            )}
          </>
        )}
      </RecoveryScreen>
    </div>
  );

  return (
    <ShellDialog
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!isApproving}
      onClose={approval ? onDone : onCancel}
      contentClassName="min-h-[510px]"
    >
      {isApproving ? (
        <ProcessingScreen
          seedAddress={guardian}
          avatarUrl={guardianIdentity.avatar}
          appAvatar={<AppAvatar appName={appName} appLogoUrl={appLogoUrl} />}
          title="Approving recovery"
          subtitle="Confirm with your passkey"
        />
      ) : approval && ceremony ? (
        <GuardianApproved
          ceremony={ceremony}
          approval={approval}
          guardian={guardian}
          mainnetRpcUrl={mainnetRpcUrl}
          onDone={onDone}
        />
      ) : (
        renderReview()
      )}
    </ShellDialog>
  );
};

export * from './GuardianApproval';
export * from './types';
