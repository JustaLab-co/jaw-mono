import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  type Ceremony,
  type CeremonyChainStatus,
  type RecoveryChainConfig,
} from '@jaw.id/core';
import type { Hex } from 'viem';
import { formatRecoveryDelay } from './recoverySetup';

// ============================================================================
// Recovery requests: the vocabulary the start and status screens speak.
//
// The sibling of `recoverySetup.ts` for the recovering user. Core serves the request as the
// backend holds it (`getCeremony`); what lives here is how its per-network statuses read as one
// stage, how each network and each moment is labelled, and where the guardians' link points.
// ============================================================================

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The networks where a recovery can run for the account: deployed there, the recovery manager an
 * owner, at least one guardian. The same test `Account.startRecovery` makes before any prompt.
 */
export function recoveryOnNetworks(chains: RecoveryChainConfig[]): RecoveryChainConfig[] {
  return chains
    .filter((chain) => chain.deployed && chain.enrolled && chain.recoveries.length > 0)
    .sort((a, b) => a.chainId - b.chainId);
}

/** The page a guardian opens for this request: the request id as the last path segment. */
export function recoveryApproveLink(approveUrl: string, requestId: Hex): string {
  return `${approveUrl.replace(/\/+$/, '')}/${requestId}`;
}

/**
 * Where a request stands, folded from its networks. A network still collecting approvals means
 * the guardians have work to do; one waiting out the delay means only time does; one executed
 * means the new passkey is in. The rest are endings, named by the first that applies.
 */
export type RecoveryRequestStage = 'collecting' | 'waiting' | 'recovered' | 'cancelled' | 'expired' | 'failed';

export function recoveryRequestStage(ceremony: Pick<Ceremony, 'chains'>): RecoveryRequestStage {
  const has = (...statuses: CeremonyChainStatus[]) => ceremony.chains.some((chain) => statuses.includes(chain.status));
  if (ceremony.chains.length === 0 || has('COLLECTING')) return 'collecting';
  if (has('PENDING', 'REQUESTED')) return 'waiting';
  if (has('EXECUTED')) return 'recovered';
  if (has('CANCELLED')) return 'cancelled';
  if (has('EXPIRED')) return 'expired';
  return 'failed';
}

/** No network can move any more: nothing left to poll. */
export function isRecoveryRequestSettled(ceremony: Pick<Ceremony, 'chains'>): boolean {
  return (
    ceremony.chains.length > 0 &&
    !ceremony.chains.some(
      (chain) => chain.status === 'COLLECTING' || chain.status === 'PENDING' || chain.status === 'REQUESTED'
    )
  );
}

/** The endings: a title and one line, each followed by "Start again". */
export const RECOVERY_REQUEST_ENDING_TEXT: Record<
  Extract<RecoveryRequestStage, 'cancelled' | 'expired' | 'failed'>,
  { title: string; detail: string }
> = {
  cancelled: {
    title: 'Recovery cancelled.',
    detail: 'An owner of this account cancelled the request. Nothing in the account changed.',
  },
  expired: {
    title: 'Request expired.',
    detail: 'It closed before it could finish. Nothing in the account changed.',
  },
  failed: {
    title: 'Recovery didn’t go through.',
    detail: 'Something went wrong on the network. Nothing in the account changed.',
  },
};

/** One network's own status, as its row says it. REQUESTED shows the time left instead. */
export const RECOVERY_REQUEST_NETWORK_TEXT: Record<CeremonyChainStatus, string> = {
  COLLECTING: 'Waiting for approvals',
  PENDING: 'Starting…',
  REQUESTED: 'Finishing…',
  EXECUTED: 'Recovered',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  FAILED: 'Didn’t go through',
  SKIPPED: 'Skipped',
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const time = (date: Date) => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const weekday = (date: Date) => date.toLocaleDateString('en-US', { weekday: 'short' });
const dayMonth = (date: Date) => `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}`;

/**
 * A moment as the rows say it: "2:48 PM" today, "Thu 2:52 PM" within the week ahead or behind,
 * "4 Dec, 2:52 PM" further out.
 */
export function formatRecoveryMoment(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (sameDay(date, now)) return time(date);
  if (Math.abs(date.getTime() - now.getTime()) < 6 * DAY) return `${weekday(date)} ${time(date)}`;
  return `${dayMonth(date)}, ${time(date)}`;
}

/** How long a network still waits: "47h 12m left", "12m left"; null once it is due. */
export function formatRecoveryTimeLeft(iso: string, now: Date = new Date()): string | null {
  const left = new Date(iso).getTime() - now.getTime();
  if (left <= 0) return null;
  const hours = Math.floor(left / HOUR);
  const minutes = Math.floor((left % HOUR) / MINUTE);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${Math.max(minutes, 1)}m left`;
}

/** When the request closes, and in how many days: "Thu, 4 Dec · 30 days". */
export function formatRecoveryOpenUntil(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY));
  return `${weekday(date)}, ${dayMonth(date)} · ${days === 1 ? '1 day' : `${days} days`}`;
}

/** "Today" or "Yesterday" for a moment that recent, else null. */
function recentDay(date: Date, now: Date): 'Today' | 'Yesterday' | null {
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return sameDay(date, yesterday) ? 'Yesterday' : null;
}

/**
 * When a request was opened, as a row says it: "Today, 2:36 PM", "Yesterday, 9:02 AM",
 * "4 Dec, 2:36 PM". `midSentence` lowers the day word for a row that leads with a verb ("Made
 * today, 2:35 PM").
 */
export function formatRecoveryOpened(
  iso: string,
  { midSentence = false }: { midSentence?: boolean } = {},
  now: Date = new Date()
): string {
  const date = new Date(iso);
  const recent = recentDay(date, now);
  const day = recent ? (midSentence ? recent.toLowerCase() : recent) : dayMonth(date);
  return `${day}, ${time(date)}`;
}

/** The same inside a sentence: "today at 2:36 PM", "yesterday at 9:02 AM", "on 4 Dec at 2:36 PM". */
export function formatRecoveryOpenedAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const recent = recentDay(date, now);
  return `${recent ? recent.toLowerCase() : `on ${dayMonth(date)}`} at ${time(date)}`;
}

// ============================================================================
// The guardian approving and the owner cancelling.
// ============================================================================

/**
 * Why a guardian can't approve a request: the key signed in on this device is none of its
 * guardians, or the request no longer collects approvals (enough came in, or it ended).
 */
export type GuardianApprovalBlock = 'not-guardian' | 'closed';

/**
 * What stops this guardian approving, or null when nothing does. A key that is not known on this
 * device is not judged here: core refuses it (-32602) before any prompt.
 */
export function guardianApprovalBlock(
  ceremony: Pick<Ceremony, 'chains' | 'guardians'>,
  guardianKey?: Hex
): GuardianApprovalBlock | null {
  if (
    guardianKey &&
    !ceremony.guardians.some(
      (guardian) =>
        guardian.provider.toLowerCase() === SIGNATURE_RECOVERY_PROVIDER_ADDRESS.toLowerCase() &&
        guardian.commitment.toLowerCase() === guardianKey.toLowerCase()
    )
  ) {
    return 'not-guardian';
  }
  return recoveryRequestStage(ceremony) === 'collecting' ? null : 'closed';
}

/**
 * The networks where an owner's veto can land: those where the request is queued or waiting out
 * its delay, the networks `Account.cancelRecovery` relays to. Before enough guardians approve,
 * nothing is on chain to cancel.
 */
export function recoveryCancellableChainIds(ceremony: Pick<Ceremony, 'chains'>): number[] {
  return ceremony.chains
    .filter((chain) => chain.status === 'PENDING' || chain.status === 'REQUESTED')
    .map((chain) => chain.chainId);
}

/**
 * The soonest a request could take effect, as the cancel screen says it: the first network's due
 * time once one is waiting, else the wait counted from what is still missing ("48h after the next
 * approval").
 */
export function formatRecoveryCouldFinish(
  ceremony: Pick<Ceremony, 'chains' | 'collected' | 'threshold'>,
  delay: number | null,
  now: Date = new Date()
): string {
  const due = ceremony.chains
    .filter((chain) => chain.status === 'REQUESTED' && chain.executeAt)
    .map((chain) => chain.executeAt as string)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
  if (due) return formatRecoveryMoment(due, now);
  if (delay === null) return 'Not set';

  const wait = formatRecoveryDelay(delay);
  if (ceremony.chains.some((chain) => chain.status === 'PENDING')) return `${wait} from now`;
  const missing = Math.max(ceremony.threshold - ceremony.collected, 1);
  return missing === 1 ? `${wait} after the next approval` : `${wait} after ${missing} more approvals`;
}
