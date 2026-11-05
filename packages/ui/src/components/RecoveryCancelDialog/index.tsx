'use client';

import type { ReactNode } from 'react';
import { minimumRecoveryDelay, type RecoverySetupResult } from '@jaw.id/core';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { ShellDialog } from '../ShellDialog';
import { ProcessingScreen } from '../ProcessingScreen';
import { DialogAppHeader } from '../DialogAppHeader';
import { AppAvatar } from '../AppAvatar';
import {
  NetworkFeesRow,
  NetworkGroup,
  NetworkStatusList,
  RecoveryFact,
  RecoveryNotice,
  SectionHeading,
} from '../RecoveryDialog/Sections';
import { RecoveryScreen } from '../RecoveryStartDialog/RecoveryScreen';
import { ceremonyWait, useRecoveryName } from '../GuardianApproveDialog/GuardianApproval';
import { getDisplayAddress } from '../../utils';
import { useChainIcons } from '../../hooks/useChainIcons';
import { useRecoveryRelayStatus } from '../../hooks/useRecoveryRelayStatus';
import { recoveryMethodAddress } from '../../utils/recoverySetup';
import {
  RECOVERY_REQUEST_ENDING_TEXT,
  formatRecoveryCouldFinish,
  formatRecoveryOpened,
  recoveryCancellableChainIds,
  recoveryRequestStage,
} from '../../utils/recoveryRequest';
import type { RecoveryCancelDialogProps } from './types';

/** A cancel that landed reads as one; a network where the request wasn't waiting had nothing to cancel. */
const CANCEL_OUTCOME_TEXT = { active: 'Cancelled', 'up-to-date': 'Nothing to cancel' } as const;

/**
 * The owner's veto: someone asked to add a new passkey to the account, and the owner, still
 * holding a key, stops it. One signature, relayed to every network where the request waits, and
 * JAW pays. Before enough guardians approve, nothing is on any network yet, so there is nothing
 * to cancel and the screen says so.
 *
 * What is signed is the cancel of the request this screen shows, by its id.
 */
export const RecoveryCancelDialog = ({
  open,
  onOpenChange,
  origin,
  appName,
  appLogoUrl,
  apiKey,
  mainnetRpcUrl,
  ceremony,
  failed,
  onConfirm,
  isCancelling,
  result,
  error,
  onCancel,
  onDone,
}: RecoveryCancelDialogProps) => {
  const { name: owner, avatar } = useRecoveryName(ceremony?.account, mainnetRpcUrl);
  const icons = useChainIcons(apiKey);

  const cancellable = ceremony ? recoveryCancellableChainIds(ceremony) : [];
  const canConfirm = cancellable.length > 0 && !isCancelling;

  const header = (title: string) => (
    <div className="flex-none px-6 pt-6">
      <DialogAppHeader appName={appName} appLogoUrl={appLogoUrl} origin={origin} />
      <h2 className="text-foreground text-title-xl mt-4">{title}</h2>
    </div>
  );

  const renderNothingToCancel = () => {
    if (!ceremony) return null;
    const stage = recoveryRequestStage(ceremony);
    if (stage === 'collecting') {
      const wait = ceremonyWait(ceremony);
      return (
        <RecoveryNotice tone="warning" title="Nothing to cancel yet">
          The request reaches the networks only once enough guardians approve. Then you can cancel it here
          {wait ? ` during the ${wait} wait` : ''}. If it wasn’t you, tell your guardians not to approve it.
        </RecoveryNotice>
      );
    }
    return (
      <RecoveryNotice tone="info" title="Nothing to cancel">
        {stage === 'recovered'
          ? 'The recovery already went through.'
          : stage === 'waiting'
            ? null
            : RECOVERY_REQUEST_ENDING_TEXT[stage].detail}
      </RecoveryNotice>
    );
  };

  const renderReview = () => (
    <div className="flex min-h-0 flex-1 flex-col">
      {header('Cancel this recovery?')}

      <RecoveryScreen
        className="pt-4"
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={onCancel}
              disabled={isCancelling}
              className="rounded-box text-button h-11 flex-[44] font-semibold focus-visible:ring-1"
            >
              Not now
            </Button>
            <Button
              variant="destructive"
              onClick={onConfirm}
              disabled={!canConfirm}
              className="rounded-box text-button h-11 flex-[56] font-semibold focus-visible:ring-1"
            >
              Cancel recovery
            </Button>
          </div>
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
              Someone asked to add a new passkey to {owner}. If it wasn’t you, cancel it. Your account stays as it is.
            </p>

            <div className="flex flex-col gap-2">
              <SectionHeading label="Request" />
              <div className="border-border rounded-box overflow-hidden border">
                <RecoveryFact label="Requested">{formatRecoveryOpened(ceremony.createdAt)}</RecoveryFact>
                <RecoveryFact label="New passkey">
                  <span className="text-body-xs font-mono font-medium">
                    {getDisplayAddress(undefined, recoveryMethodAddress(ceremony.subject) ?? ceremony.subject)}
                  </span>
                </RecoveryFact>
                <RecoveryFact label="Approvals">{`${ceremony.collected} of ${ceremony.threshold}`}</RecoveryFact>
                <RecoveryFact label="Could finish">
                  {formatRecoveryCouldFinish(ceremony, minimumRecoveryDelay(ceremony.guardians, ceremony.threshold))}
                </RecoveryFact>
              </div>
            </div>

            {cancellable.length > 0 ? (
              <div className="flex flex-col gap-2">
                <SectionHeading label="Networks" />
                <div className="border-border rounded-box overflow-hidden border">
                  <NetworkGroup
                    rows={cancellable.map((chainId) => ({ network: { chainId } }))}
                    icons={icons}
                    status={<span className="text-foreground text-body-sm flex-none">Included</span>}
                  />
                  <NetworkFeesRow />
                </div>
              </div>
            ) : (
              renderNothingToCancel()
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
      dismissable={!isCancelling}
      onClose={result ? () => onDone(result) : onCancel}
      contentClassName="min-h-[510px]"
    >
      {isCancelling ? (
        <ProcessingScreen
          seedAddress={ceremony?.account ?? ''}
          avatarUrl={avatar}
          appAvatar={<AppAvatar appName={appName} appLogoUrl={appLogoUrl} />}
          title="Cancelling recovery"
          subtitle="Confirm with your passkey"
        />
      ) : result ? (
        <RecoveryCancelled result={result} header={header} apiKey={apiKey} onDone={onDone} />
      ) : (
        renderReview()
      )}
    </ShellDialog>
  );
};

/**
 * The outcome per network: the veto is relayed, so each network is polled until none is in
 * flight. Done is always enabled: the relay carries on in the background.
 */
function RecoveryCancelled({
  result,
  header,
  apiKey,
  onDone,
}: {
  result: RecoverySetupResult;
  header: (title: string) => ReactNode;
  apiKey?: string;
  onDone: (result: RecoverySetupResult) => void;
}) {
  const { chains, timedOut } = useRecoveryRelayStatus(result.batchId, result.chains, apiKey);
  const failed = chains.some((chain) => chain.status === 'EXPIRED' || chain.status === 'DEAD');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header('Recovery cancelled')}

      <RecoveryScreen
        footer={
          <Button
            onClick={() => onDone({ ...result, chains })}
            className="rounded-box text-button h-11 w-full font-semibold focus-visible:ring-1"
          >
            Done
          </Button>
        }
      >
        <NetworkStatusList chains={chains} apiKey={apiKey} labels={CANCEL_OUTCOME_TEXT} />
        <p className="text-muted-foreground text-body-sm">
          {failed
            ? 'It didn’t go through on every network. Cancel again from this account before the wait ends.'
            : timedOut
              ? 'Still updating in the background. Open the app again later to check.'
              : 'That new passkey can’t be added now. Anyone trying again has to start a new request, and your guardians would have to approve it again.'}
        </p>
      </RecoveryScreen>
    </div>
  );
}

export * from './types';
