'use client';

import type { ReactNode } from 'react';
import { minimumRecoveryDelay, type Ceremony, type CeremonyApproval, type CeremonyListEntry } from '@jaw.id/core';
import type { Address, Hex } from 'viem';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { AccountAvatar } from '../AccountAvatar';
import { SuccessCheck } from '../SuccessCheck';
import { RecoveryFact, RecoveryNotice } from '../RecoveryDialog/Sections';
import { RecoveryScreen, RecoveryScreenTitle } from '../RecoveryStartDialog/RecoveryScreen';
import { getDisplayAddress } from '../../utils';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import { formatRecoveryDelay } from '../../utils/recoverySetup';
import {
  RECOVERY_REQUEST_ENDING_TEXT,
  formatRecoveryOpened,
  recoveryRequestStage,
  type GuardianApprovalBlock,
} from '../../utils/recoveryRequest';

// ============================================================================
// The guardian's approval, in pieces: the app's dialog (GuardianApproveDialog) and keys' guardian
// page put them together with their own header and buttons. Names are read on mainnet: a
// recovery is account-level, on every network.
// ============================================================================

const NAME_CHAIN_ID = 1;

/** A name as the guardian knows it: the address's reverse name, else its short address. */
export function useRecoveryName(address: Address | undefined, mainnetRpcUrl: string) {
  const identity = useReverseIdentity(address, NAME_CHAIN_ID, mainnetRpcUrl);
  return { name: identity.name ?? (address ? getDisplayAddress(undefined, address) : ''), avatar: identity.avatar };
}

/** The wait a request runs once enough guardians approve, as the rows say it: "48h". */
export function ceremonyWait(ceremony: Pick<Ceremony, 'guardians' | 'threshold'>): string | null {
  const delay = minimumRecoveryDelay(ceremony.guardians, ceremony.threshold);
  return delay === null ? null : formatRecoveryDelay(delay);
}

/** Who approves, by name, with a small avatar: the "Approving as" and "Approved as" rows. */
function GuardianValue({ address, mainnetRpcUrl }: { address: Address; mainnetRpcUrl: string }) {
  const { name, avatar } = useRecoveryName(address, mainnetRpcUrl);
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5">
      <AccountAvatar seed={address} avatarUrl={avatar} size={16} className="rounded-xs size-4 flex-none" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * What the guardian is approving: the account, when its new passkey was made, the wait before it
 * works, and who approves when the guardian is signed in.
 */
export function GuardianRequestFacts({
  ceremony,
  guardian,
  mainnetRpcUrl,
}: {
  ceremony: Ceremony;
  /** The signed-in guardian: adds "Approving as". */
  guardian?: Address;
  mainnetRpcUrl: string;
}) {
  const account = useReverseIdentity(ceremony.account, NAME_CHAIN_ID, mainnetRpcUrl);
  const short = getDisplayAddress(undefined, ceremony.account);
  const wait = ceremonyWait(ceremony);

  return (
    <div className="border-border rounded-box overflow-hidden border">
      <RecoveryFact label="Account">
        <span className="flex min-w-0 items-center justify-end gap-2">
          <AccountAvatar
            seed={ceremony.account}
            avatarUrl={account.avatar}
            size={20}
            className="rounded-xs size-5 flex-none"
          />
          <span className="flex min-w-0 flex-col items-end gap-0.5">
            <span className="max-w-full truncate">{account.name ?? short}</span>
            {account.name && <span className="text-muted-foreground text-code font-mono font-normal">{short}</span>}
          </span>
        </span>
      </RecoveryFact>
      <RecoveryFact label="New passkey">{`Made ${formatRecoveryOpened(ceremony.createdAt, { midSentence: true })}`}</RecoveryFact>
      <RecoveryFact label="Waiting period">{wait === null ? 'Not set' : `${wait} before it works`}</RecoveryFact>
      {guardian && (
        <RecoveryFact label="Approving as">
          <GuardianValue address={guardian} mainnetRpcUrl={mainnetRpcUrl} />
        </RecoveryFact>
      )}
    </div>
  );
}

/** One checkbox row, the whole row its label. */
function CheckRow({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="border-border rounded-box flex min-h-11 cursor-pointer items-start gap-2.5 border p-3">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="text-foreground text-body-sm">{children}</span>
    </label>
  );
}

/**
 * The two things a guardian confirms before approving: they reached the owner themselves, on a
 * channel they already had, and nobody is pushing them. Approve stays off until both are ticked.
 */
export function GuardianChecks({
  owner,
  contacted,
  calm,
  onContactedChange,
  onCalmChange,
  disabled,
}: {
  /** The account's name, as the guardian knows it. */
  owner: string;
  contacted: boolean;
  calm: boolean;
  onContactedChange: (checked: boolean) => void;
  onCalmChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <CheckRow checked={contacted} onChange={onContactedChange} disabled={disabled}>
        I contacted {owner} myself, on a number or account I already had, and they confirmed they started this.
      </CheckRow>
      <CheckRow checked={calm} onChange={onCalmChange} disabled={disabled}>
        No one is rushing me. If anything feels off, I won’t approve.
      </CheckRow>
    </>
  );
}

/** Why this guardian can't approve: none of the request's guardians, or the request moved on. */
export function GuardianBlockNotice({
  block,
  ceremony,
  owner,
}: {
  block: GuardianApprovalBlock;
  ceremony: Pick<Ceremony, 'chains'>;
  owner: string;
}) {
  if (block === 'not-guardian') {
    return (
      <RecoveryNotice tone="destructive" title="This account isn’t a guardian for this request">
        Only the guardians {owner} chose can approve it.
      </RecoveryNotice>
    );
  }

  const stage = recoveryRequestStage(ceremony);
  const detail =
    stage === 'waiting'
      ? 'Enough guardians already approved it. Nothing left for you to do.'
      : stage === 'recovered'
        ? 'The recovery already went through. Nothing left for you to do.'
        : stage === 'collecting'
          ? null
          : RECOVERY_REQUEST_ENDING_TEXT[stage].detail;
  return (
    <RecoveryNotice tone="info" title="This request can’t be approved any more">
      {detail}
    </RecoveryNotice>
  );
}

/**
 * More than one request is open for the account: say how many and when each was opened, so the
 * guardian can ask the owner which one is theirs. Someone else may have opened one alongside.
 */
export function OpenRequestsNotice({
  requests,
  requestId,
  owner,
}: {
  /** The account's requests that can still complete, newest first. */
  requests: Pick<CeremonyListEntry, 'requestId' | 'createdAt'>[];
  /** The request on screen. */
  requestId: Hex;
  owner: string;
}) {
  if (requests.length < 2) return null;
  return (
    <RecoveryNotice tone="warning" title={`${requests.length} recovery requests are open for this account`}>
      {requests.map((request) => (
        <span key={request.requestId} className="block">
          {request.requestId.toLowerCase() === requestId.toLowerCase() ? 'This one' : 'Another'}: opened{' '}
          {formatRecoveryOpened(request.createdAt, { midSentence: true })}
        </span>
      ))}
      <span className="mt-1 block">Ask {owner} when they started theirs, and approve only that one.</span>
    </RecoveryNotice>
  );
}

/**
 * After the guardian signed: who approved, the count so far, and what happens next. The count
 * shows only now, once this approval is in.
 */
export function GuardianApproved({
  ceremony,
  approval,
  guardian,
  mainnetRpcUrl,
  onDone,
}: {
  ceremony: Ceremony;
  approval: CeremonyApproval;
  /** The guardian who approved. */
  guardian?: Address;
  mainnetRpcUrl: string;
  /** Done. Absent on a full page, which has nothing to close: the screen has no footer. */
  onDone?: () => void;
}) {
  const { name: owner } = useRecoveryName(ceremony.account, mainnetRpcUrl);
  const wait = ceremonyWait(ceremony) ?? formatRecoveryDelay(0);
  const reached = approval.queued || approval.collected >= approval.threshold;

  return (
    <RecoveryScreen
      className="pt-10"
      footer={
        onDone && (
          <Button onClick={onDone} className="rounded-box text-button h-11 w-full font-semibold focus-visible:ring-1">
            Done
          </Button>
        )
      }
    >
      <SuccessCheck size={48} />
      <RecoveryScreenTitle title="You approved.">Your approval counts on every network.</RecoveryScreenTitle>

      <div className="border-border rounded-box mt-2 overflow-hidden border">
        {guardian && (
          <RecoveryFact label="Approved as">
            <GuardianValue address={guardian} mainnetRpcUrl={mainnetRpcUrl} />
          </RecoveryFact>
        )}
        <RecoveryFact label="Approvals">{`${approval.collected} of ${approval.threshold}`}</RecoveryFact>
      </div>

      <RecoveryNotice tone="info" title="What happens now">
        {reached
          ? `Enough guardians approved, so the request goes on every network and waits ${wait}.`
          : `Once ${approval.threshold} guardians approve, the request goes on every network and waits ${wait}.`}{' '}
        {owner} can cancel it at any time until then.
      </RecoveryNotice>
    </RecoveryScreen>
  );
}
