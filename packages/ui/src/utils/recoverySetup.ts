import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  isFirstRecoverySetup,
  planRecoveryChanges,
  type AdminBatchStatus,
  type RecoveryChainConfig,
  type RecoveryConfig,
  type RecoveryMethodInput,
  type RecoveryNetwork,
  type RecoveryNetworksPlan,
  type TransactionCall,
} from '@jaw.id/core';
import { size, type Address, type Hex } from 'viem';
import { formatAddress } from './formatAddress';

// ============================================================================
// Recovery setup: the vocabulary the setup and manage screens speak.
//
// The sibling of `permissionExecution.ts` for recovery. Core owns the networks read and the change
// planner; what lives here is UI vocabulary: the named reasons a setup can't go ahead, the
// guardrails on the time to cancel, how a wait and a method are labelled, and how each network
// reads before and after a relayed change.
// ============================================================================

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Under this the veto window counts as short, and the screen says so. */
export const SHORT_RECOVERY_DELAY_SECONDS = 24 * HOUR;

/** Something worth saying before a recovery setup. Every member blocks Continue. */
export type RecoverySetupProblem =
  /** The networks read failed (network, server error, missing key, an owner read). */
  'lookup-failed';

/** Short label and the detail behind it, one sentence pair per problem. */
export const RECOVERY_SETUP_PROBLEM_TEXT: Record<RecoverySetupProblem, { text: string; detail: string }> = {
  'lookup-failed': {
    text: 'Recovery settings couldn’t be loaded',
    detail:
      'The account’s current recovery settings couldn’t be read, so a change can’t be built against them. Close this and try again.',
  },
};

/**
 * What the time to cancel is worth saying (O8). Advice only: the user may pick any wait.
 * - `zero`: recovery can complete instantly. Confirmed on the next screen.
 * - `short`: under 24h to notice and cancel.
 */
export type RecoveryDelayWarning = 'zero' | 'short';

export function recoveryDelayWarning(minimumDelay: number | null): RecoveryDelayWarning | null {
  if (minimumDelay === null) return null;
  if (minimumDelay === 0) return 'zero';
  if (minimumDelay < SHORT_RECOVERY_DELAY_SECONDS) return 'short';
  return null;
}

export const RECOVERY_DELAY_WARNING_TEXT: Record<RecoveryDelayWarning, { text: string; detail: string }> = {
  zero: {
    text: 'No waiting period',
    detail: 'Recovery can complete instantly, with no chance to cancel. You’ll be asked to confirm this choice.',
  },
  short: {
    text: 'Short veto window',
    detail: 'A shorter wait means less time to notice and cancel a malicious request.',
  },
};

/**
 * A wait as the screens say it: "1 min", "48h", "7 days". The chain stores seconds, so a proposal
 * can carry any value; this never rounds a short wait up to a longer one it isn't.
 */
export function formatRecoveryDelay(seconds: number): string {
  if (seconds === 0) return '0h';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < HOUR) return `${Math.floor(seconds / 60)} min`;
  // Whole weeks and beyond read as days; under that, hours ("72h", as the walkthrough writes it).
  if (seconds % DAY === 0 && seconds >= 7 * DAY) return `${seconds / DAY} days`;
  return `${Number((seconds / HOUR).toFixed(1))}h`;
}

/**
 * How a recovery method approves, as the row's pill says it. A provider this SDK doesn't know shows
 * as its short address rather than a guessed name.
 */
export function recoveryMethodLabel(provider: string, commitment: Hex): string {
  if (provider.toLowerCase() !== SIGNATURE_RECOVERY_PROVIDER_ADDRESS.toLowerCase()) return formatAddress(provider);
  return size(commitment) === 64 ? 'Passkey' : 'Wallet';
}

/** The address a 32-byte commitment pads, or null for a passkey's 64-byte public key. */
export function recoveryMethodAddress(commitment: Hex): Hex | null {
  return size(commitment) === 32 ? `0x${commitment.slice(-40)}` : null;
}

/** A relayed change on one network, as the status list shows it. */
export type RecoveryRelayState = 'updating' | 'active' | 'up-to-date' | 'failed';

export function recoveryRelayState(status: AdminBatchStatus): RecoveryRelayState {
  switch (status) {
    case 'PENDING':
    case 'CLAIMED':
    case 'SUBMITTED':
      return 'updating';
    case 'COMPLETED':
      return 'active';
    // Already satisfied, not enrolled there, or no longer pending: nothing left to do.
    case 'SKIPPED':
      return 'up-to-date';
    case 'EXPIRED':
    case 'DEAD':
      return 'failed';
  }
}

export const RECOVERY_RELAY_STATE_TEXT: Record<RecoveryRelayState, string> = {
  updating: 'Updating…',
  active: 'Active',
  'up-to-date': 'Already up to date',
  failed: 'Didn’t go through',
};

/**
 * One guardian on the review screen: `added`, `removed`, a new wait (`delay`, with the old one),
 * or `null` for one that stays as it is.
 */
export type RecoveryGuardianRow = {
  method: Required<RecoveryMethodInput>;
  change: 'added' | 'removed' | 'delay' | null;
  fromDelay?: number;
};

function sameMethod(a: { provider: string; commitment: string }, b: { provider: string; commitment: string }) {
  return (
    a.provider.toLowerCase() === b.provider.toLowerCase() && a.commitment.toLowerCase() === b.commitment.toLowerCase()
  );
}

/**
 * The guardians as one list: the end state the app asked for, each marked against the current
 * config, then the guardians it removes. A first setup (`current` null) marks nothing: every
 * guardian on it is new.
 */
export function recoveryGuardianRows(
  current: RecoveryChainConfig | null,
  desired: RecoveryMethodInput[]
): RecoveryGuardianRow[] {
  const wanted = desired.map((method) => ({
    ...method,
    provider: method.provider ?? SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  }));
  if (!current) return wanted.map((method) => ({ method, change: null }));

  const rows: RecoveryGuardianRow[] = wanted.map((method) => {
    const existing = current.recoveries.find((registered) => sameMethod(registered, method));
    if (!existing) return { method, change: 'added' };
    if (existing.delay !== method.delay) return { method, change: 'delay', fromDelay: existing.delay };
    return { method, change: null };
  });

  for (const registered of current.recoveries) {
    if (!wanted.some((method) => sameMethod(registered, method))) {
      const { commitment, provider, delay } = registered;
      rows.push({ method: { commitment, provider, delay }, change: 'removed' });
    }
  }

  return rows;
}

/**
 * Why no network can take a change yet, judged on the connected network, where a transaction would
 * go. Null while some network can.
 * - `deploy`: one transaction deploys the account there, with what a change needs.
 * - `enable`: one transaction adds the owners a change needs there.
 * - `unsupported-network`: recovery doesn't run on the connected network.
 * - `not-owner`: the signing key isn't an owner of the account there.
 * - `not-available`: nothing turns recovery on for this account (created before recovery).
 */
export type RecoveryUnavailable = 'deploy' | 'enable' | 'unsupported-network' | 'not-owner' | 'not-available';

export function recoveryUnavailable(plan: RecoveryNetworksPlan, chainId: number): RecoveryUnavailable | null {
  if (plan.base) return null;
  const connected = plan.networks.find((network) => network.chainId === chainId);
  if (!connected) return 'unsupported-network';
  if (connected.enabledByTransaction) return connected.status === 'not-deployed' ? 'deploy' : 'enable';
  return connected.status === 'not-owner' ? 'not-owner' : 'not-available';
}

/** Short label and the detail behind it, for the connected network's name. */
export const RECOVERY_UNAVAILABLE_TEXT: Record<
  RecoveryUnavailable,
  { text: string; detail: (network: string) => string }
> = {
  deploy: {
    text: 'Your account isn’t on any network yet',
    detail: (network) => `Activate it on ${network} with one transaction, then set up recovery with one signature.`,
  },
  enable: {
    text: 'Recovery needs one transaction first',
    detail: (network) => `Activate recovery on ${network} with one transaction, then set it up with one signature.`,
  },
  'unsupported-network': {
    text: 'Recovery isn’t available on this network',
    detail: () => 'Switch to a network that supports recovery and try again.',
  },
  'not-owner': {
    text: 'This passkey can’t change recovery here',
    detail: (network) => `It isn’t an owner of this account on ${network}.`,
  },
  'not-available': {
    text: 'Recovery isn’t available for this account',
    detail: () => 'Only accounts created since recovery launched can turn it on.',
  },
};

/** Why a network is left out of a change, or null for one it reaches or the account isn't on. */
export function recoveryNetworkNote(network: RecoveryNetwork): string | null {
  switch (network.status) {
    case 'ready':
    case 'not-deployed':
      return null;
    case 'out-of-sync':
      return 'Different guardians';
    case 'not-owner':
      return network.enabledByTransaction ? 'After your next transaction there' : 'Can’t be changed with this passkey';
    case 'not-available':
      return network.enabledByTransaction ? 'After your next transaction there' : 'Not available for this account';
  }
}

/**
 * The transaction behind "Activate on <network>": a call to the account itself with nothing in it.
 * The account's own sends do the rest around any call: deploy the account, and add the owners a
 * recovery change needs when it lacks them.
 */
export function recoveryActivationCalls(account: Address): TransactionCall[] {
  return [{ to: account, value: 0n, data: '0x' }];
}

/** The networks a change reaches, as one comparable value. */
function readyNetworks(plan: RecoveryNetworksPlan): string {
  return plan.networks
    .filter((network) => network.status === 'ready')
    .map((network) => network.chainId)
    .sort((a, b) => a - b)
    .join(',');
}

/**
 * Whether the plan a confirm screen showed still holds against a fresh networks read: the same
 * change list from the base network, and the same networks reached. `Account` plans again from its
 * own read when it signs, so a config changed elsewhere in between (another device, another app)
 * would otherwise sign a change list nobody saw.
 */
export function recoveryPlanStillHolds(
  shown: RecoveryNetworksPlan,
  fresh: RecoveryNetworksPlan,
  reviewed: RecoveryConfig
): boolean {
  if (!shown.base || !fresh.base) return false;
  return (
    isFirstRecoverySetup(shown.base) === isFirstRecoverySetup(fresh.base) &&
    readyNetworks(shown) === readyNetworks(fresh) &&
    JSON.stringify(planRecoveryChanges(shown.base, reviewed)) ===
      JSON.stringify(planRecoveryChanges(fresh.base, reviewed))
  );
}
