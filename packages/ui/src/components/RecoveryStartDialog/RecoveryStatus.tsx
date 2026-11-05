'use client';

import type { ReactNode } from 'react';
import { Check, Clock } from 'lucide-react';
import type { Ceremony, CeremonyChain, CeremonyGuardian } from '@jaw.id/core';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { CopyButton } from '../CopyButton';
import { SuccessCheck } from '../SuccessCheck';
import {
  Badge,
  GuardianIdentity,
  NetworkIcon,
  RecoveryNotice,
  SectionHeading,
  chainName,
} from '../RecoveryDialog/Sections';
import { cn } from '../../lib/utils';
import { getDisplayAddress } from '../../utils';
import { useChainIcons } from '../../hooks/useChainIcons';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import {
  RECOVERY_REQUEST_ENDING_TEXT,
  RECOVERY_REQUEST_NETWORK_TEXT,
  formatRecoveryMoment,
  formatRecoveryOpenUntil,
  formatRecoveryTimeLeft,
  recoveryApproveLink,
  recoveryRequestStage,
} from '../../utils/recoveryRequest';
import { RecoveryScreen, RecoveryScreenTitle } from './RecoveryScreen';

/** Names on these screens are read on mainnet: a recovery is account-level, on every network. */
const NAME_CHAIN_ID = 1;

export interface RecoveryStatusProps {
  /** The request as the backend holds it (`useRecoveryRequest`); null until the first read lands. */
  ceremony: Ceremony | null;
  /** The last read failed. */
  failed?: boolean;
  /** The page guardians open; the request id is appended as a path segment. */
  approveUrl: string;
  apiKey?: string;
  mainnetRpcUrl: string;
  /** Done (or "Done for now") while the request is open. */
  onDone: () => void;
  /** "Start again" after an ending. Absent, an ending offers Done. */
  onStartAgain?: () => void;
  /** "Open my account" once the recovery executed: sign in with the new passkey. */
  onOpenAccount: () => void;
  isOpeningAccount?: boolean;
  /**
   * The network the new passkey signs in on. When the request executed on other networks but not
   * on this one, the screen names the networks the passkey works on and offers no way in: signing
   * in here would be refused again.
   */
  chainId?: number;
}

/**
 * Where a recovery request stands, for the user recovering: one view over the request, whatever
 * stage it is at. Collecting: the guardians, the link to send them and when it closes. Waiting:
 * the approvals and each network's time left. Executed: the networks and the way in. Cancelled,
 * expired or failed: a plain ending. A network shows its own status whatever the others do.
 */
export function RecoveryStatus({
  ceremony,
  failed,
  approveUrl,
  apiKey,
  mainnetRpcUrl,
  onDone,
  onStartAgain,
  onOpenAccount,
  isOpeningAccount = false,
  chainId,
}: RecoveryStatusProps) {
  const identity = useReverseIdentity(ceremony?.account, NAME_CHAIN_ID, mainnetRpcUrl);

  const doneButton = (label: string) => (
    <Button onClick={onDone} className="rounded-box text-button h-11 w-full font-semibold focus-visible:ring-1">
      {label}
    </Button>
  );

  if (!ceremony) {
    return (
      <RecoveryScreen footer={doneButton('Done')}>
        {failed ? (
          <RecoveryNotice tone="destructive" title="This request couldn’t be loaded">
            Check your connection. This screen tries again on its own.
          </RecoveryNotice>
        ) : (
          <div className="flex min-h-[200px] items-center justify-center">
            <Spinner className="size-5" />
          </div>
        )}
      </RecoveryScreen>
    );
  }

  const name = identity.name ?? getDisplayAddress(undefined, ceremony.account);
  const stage = recoveryRequestStage(ceremony);

  if (stage === 'collecting') {
    const link = recoveryApproveLink(approveUrl, ceremony.requestId);
    return (
      <RecoveryScreen
        footer={
          <>
            {doneButton('Done for now')}
            <p className="text-muted-foreground text-body-sm text-center">
              Sign in with your new passkey any time to check on it.
            </p>
          </>
        }
      >
        <div>
          <AccountPill>{`${name} · recovery started`}</AccountPill>
          <RecoveryScreenTitle title="Ask your guardians.">
            Call or message each one yourself and send them the link below. Any {ceremony.threshold} of{' '}
            {ceremony.guardians.length} can approve.
          </RecoveryScreenTitle>
        </div>

        <GuardianRows
          label={`Guardians · ${ceremony.collected} of ${ceremony.threshold} approved`}
          guardians={ceremony.guardians}
          mainnetRpcUrl={mainnetRpcUrl}
          pending={<Badge tone="muted">Waiting</Badge>}
        />

        <div className="flex flex-col gap-2">
          <SectionHeading label="Link for your guardians" />
          <div className="border-border rounded-box flex min-w-0 items-center gap-2 border p-1 pl-3">
            <span className="text-secondary-foreground text-body-xs min-w-0 flex-1 truncate font-mono">
              {link.replace(/^https?:\/\//, '')}
            </span>
            <CopyButton
              value={link}
              size={13}
              label="Copy link"
              className="bg-secondary text-foreground hover:bg-secondary/80 rounded-chip text-button h-11 gap-1.5 px-3"
            >
              Copy
            </CopyButton>
          </div>
        </div>

        <RecoveryNotice tone="info">
          Each guardian will contact you on a number or account they already have before they approve. That call is the
          check.
        </RecoveryNotice>

        <div className="text-body-sm flex justify-between gap-3 px-3">
          <span className="text-muted-foreground">Open until</span>
          <span className="text-foreground font-medium">{formatRecoveryOpenUntil(ceremony.expiry)}</span>
        </div>
      </RecoveryScreen>
    );
  }

  if (stage === 'waiting') {
    return (
      <RecoveryScreen
        footer={
          <>
            {doneButton('Done')}
            <p className="text-muted-foreground text-body-sm text-center">
              You’ll see this whenever you sign in with your new passkey until it finishes.
            </p>
          </>
        }
      >
        <div>
          <AccountPill>{`${name} · recovery in progress`}</AccountPill>
          <RecoveryScreenTitle title="Waiting period.">
            Your guardians approved. Recovery finishes on its own when the wait ends on each network.
          </RecoveryScreenTitle>
        </div>

        <GuardianRows
          label={`Approvals · ${ceremony.collected} of ${ceremony.threshold}`}
          guardians={ceremony.guardians}
          mainnetRpcUrl={mainnetRpcUrl}
          pending={<span className="text-muted-foreground text-body-sm flex-none">Not needed</span>}
          dimPending
        />

        <div className="flex flex-col gap-2">
          <SectionHeading label="Networks" />
          <CeremonyNetworks chains={ceremony.chains} apiKey={apiKey} />
        </div>

        <RecoveryNotice tone="info" icon={Clock}>
          Nothing left for you to do. Your old passkey can still cancel this until then. That’s what the wait is for.
        </RecoveryNotice>
      </RecoveryScreen>
    );
  }

  const executedHere = ceremony.chains.some((chain) => chain.chainId === chainId && chain.status === 'EXECUTED');
  if (stage === 'recovered' && chainId !== undefined && !executedHere) {
    return (
      <RecoveryScreen className="pt-10" footer={doneButton('Done')}>
        <RecoveryScreenTitle title="Recovered on other networks.">
          Your new passkey now controls {name} on the networks below. It can’t be used on {chainName(chainId)} yet.
        </RecoveryScreenTitle>
        <CeremonyNetworks chains={ceremony.chains.filter((chain) => chain.status === 'EXECUTED')} apiKey={apiKey} />
        <RecoveryNotice tone="warning" title="Works on these networks only">
          Networks this account never used before the recovery can’t be used with the new passkey yet.
        </RecoveryNotice>
      </RecoveryScreen>
    );
  }

  if (stage === 'recovered') {
    return (
      <RecoveryScreen
        className="pt-10"
        footer={
          <Button
            onClick={onOpenAccount}
            disabled={isOpeningAccount}
            className="rounded-box text-button h-11 w-full font-semibold focus-visible:ring-1"
          >
            {isOpeningAccount && <Spinner className="size-4" />}
            Open my account
          </Button>
        }
      >
        <SuccessCheck size={48} />
        <RecoveryScreenTitle title="You’re back in.">
          Your new passkey now controls {name}. Nothing in the account moved.
        </RecoveryScreenTitle>
        <CeremonyNetworks chains={ceremony.chains} apiKey={apiKey} />
        <RecoveryNotice tone="warning" title="Works on these networks only">
          Networks this account never used before the recovery can’t be used with the new passkey yet.
        </RecoveryNotice>
      </RecoveryScreen>
    );
  }

  const ending = RECOVERY_REQUEST_ENDING_TEXT[stage];
  return (
    <RecoveryScreen
      footer={
        onStartAgain ? (
          <Button
            onClick={onStartAgain}
            className="rounded-box text-button h-11 w-full font-semibold focus-visible:ring-1"
          >
            Start again
          </Button>
        ) : (
          doneButton('Done')
        )
      }
    >
      <RecoveryScreenTitle title={ending.title}>{ending.detail}</RecoveryScreenTitle>
    </RecoveryScreen>
  );
}

/** The account and the request's stage, above the title. */
function AccountPill({ children }: { children: string }) {
  return (
    <div className="mb-3 flex pr-8">
      <Badge tone="muted" className="min-w-0 truncate">
        {children}
      </Badge>
    </div>
  );
}

/** The guardians, each with its approval time, or what it shows while it has not approved. */
function GuardianRows({
  label,
  guardians,
  mainnetRpcUrl,
  pending,
  dimPending,
}: {
  label: string;
  guardians: CeremonyGuardian[];
  mainnetRpcUrl: string;
  /** Shown in place of the approval time while a guardian has not approved. */
  pending: ReactNode;
  /** A guardian whose approval is no longer needed: shown faded. */
  dimPending?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading label={label} />
      <div className="border-border rounded-box overflow-hidden border">
        {guardians.map((guardian) => (
          <div
            key={guardian.recoveryId}
            className={cn(
              'border-border/40 flex min-h-12 items-center gap-2 border-t px-3 py-2 first:border-t-0',
              dimPending && !guardian.approvedAt && 'opacity-60'
            )}
          >
            <GuardianIdentity commitment={guardian.commitment} chainId={NAME_CHAIN_ID} mainnetRpcUrl={mainnetRpcUrl} />
            {guardian.approvedAt ? (
              <span className="text-success text-body-sm flex flex-none items-center gap-1 font-semibold">
                <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
                <span className="sr-only">Approved </span>
                {formatRecoveryMoment(guardian.approvedAt)}
              </span>
            ) : (
              pending
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Each network the request reaches, with its own status. */
function CeremonyNetworks({ chains, apiKey }: { chains: CeremonyChain[]; apiKey?: string }) {
  const icons = useChainIcons(apiKey);

  return (
    <div className="border-border rounded-box overflow-hidden border">
      {chains.map((chain) => (
        <div
          key={chain.chainId}
          className="border-border/40 flex min-h-11 items-center justify-between gap-3 border-t px-3 py-2 first:border-t-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            <NetworkIcon icon={icons[chain.chainId]} />
            <span className="text-foreground text-body-sm font-medium">{chainName(chain.chainId)}</span>
          </span>
          <CeremonyNetworkState chain={chain} />
        </div>
      ))}
    </div>
  );
}

function CeremonyNetworkState({ chain }: { chain: CeremonyChain }) {
  const left = chain.status === 'REQUESTED' && chain.executeAt ? formatRecoveryTimeLeft(chain.executeAt) : null;
  if (left && chain.executeAt) {
    return (
      <span className="flex flex-none flex-col items-end gap-0.5">
        <span className="text-foreground text-body-sm font-semibold">{left}</span>
        <span className="text-muted-foreground text-body-xs">{formatRecoveryMoment(chain.executeAt)}</span>
      </span>
    );
  }

  const text = RECOVERY_REQUEST_NETWORK_TEXT[chain.status];
  const moving = chain.status === 'PENDING' || chain.status === 'REQUESTED';
  return (
    <span
      className={cn(
        'text-body-sm flex flex-none items-center gap-1.5 font-medium',
        chain.status === 'EXECUTED' && 'text-success font-semibold',
        (chain.status === 'CANCELLED' || chain.status === 'EXPIRED' || chain.status === 'FAILED') &&
          'text-destructive dark:text-negative',
        (moving || chain.status === 'SKIPPED' || chain.status === 'COLLECTING') && 'text-muted-foreground'
      )}
    >
      {moving && <Spinner className="size-3.5" />}
      {chain.status === 'EXECUTED' && <Check className="size-3.5" strokeWidth={2.5} aria-hidden />}
      {text}
    </span>
  );
}
