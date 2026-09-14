import { parseBigInt } from './amount.js';
import { sanitizeLine } from '../lib/terminal.js';
import type { PermissionLiveness } from './permission-onchain.js';

/**
 * Presentation and diagnosis for `jaw x402 status`, kept apart from the command
 * so the rules can be tested without a session, a keystore or a network.
 */

/** Base units to a readable amount, trailing zeros trimmed. */
export function formatUsdc(base: string | undefined, decimals: number): string {
  if (base === undefined) return 'unlimited';
  const value = parseBigInt(base);
  // Echoing the raw value put an unvalidated string on screen: amounts reach
  // here from the ledger and from config, both files that can be edited.
  if (value === null) return `${sanitizeLine(base, 32)} (invalid)`;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} USDC`;
}

export function formatRemaining(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} left`;
  const hours = Math.max(0, Math.floor(seconds / 3600));
  return `${hours}h left`;
}

export interface StatusFacts {
  expired: boolean;
  /**
   * Defaults to `unknown`, which reports exactly what every session reported
   * before this could be read: the local file, and nothing more.
   */
  liveness?: PermissionLiveness;
  /**
   * True for a session an older CLI created, whose permission was granted to an
   * address separate from the session key. Auto mode refuses those, so a report
   * that stayed quiet about it would call a setup ready that cannot pay.
   */
  outdated?: boolean;
  ownerAddress: string;
  /** Formatted balance, or null when the read failed. */
  ownerBalance: string | null;
  payerBalance: string | null;
  /** False when the session's chain has no USDC in the registry. */
  hasAsset: boolean;
  spent: bigint;
  sessionCap: bigint | null;
  /**
   * The granted per-period cap and what has gone against it in the current
   * window: top-ups pulled through the permission, not payments, because the
   * cap mirrors the on-chain allowance and payments lag it by whatever float
   * the payer holds. Null when no grant seeded one. Reported separately from
   * the session cap because a grant-seeded policy usually has no session cap
   * at all, and checking only that one stayed quiet while the cap that
   * actually binds was exhausted.
   */
  periodCap?: bigint | null;
  periodSpent?: bigint | null;
  /** How the window reads in a sentence, e.g. "day" or "2 weeks". */
  periodLabel?: string | null;
  /**
   * The gas reserve refills leave in the payer, in the same formatted units as
   * the balances. A payer holding no more than this is holding what the CLI put
   * there to pay userOp fees, so it is not the misdirected-funds case below.
   */
  payerReserve?: number;
}

/**
 * What is stopping a payment, most likely cause first. Empty when nothing is.
 *
 * The interesting case is an empty owner next to a funded payer: payments still
 * succeed, so nothing looks wrong, but they are spending the payer's own balance
 * instead of pulling through the permission, which means the cap the user
 * granted is not being applied to anything.
 */
export function diagnose(facts: StatusFacts): string[] {
  const problems: string[] = [];

  if (facts.expired) {
    problems.push('The session expired. Run `jaw session setup --x402`.');
  }

  // Only the chain knows this one. Expiry is the same number the local file
  // carries, so it needs no read; a revoke made from keys.jaw.id or from
  // another machine leaves that file saying the session is fine.
  if (facts.liveness === 'revoked') {
    problems.push(
      'The permission was revoked on chain, so nothing can be pulled through it any more. ' +
        'Run `jaw session setup --x402` to grant a new one.'
    );
  }

  if (facts.liveness === 'unapproved') {
    problems.push(
      'The chain has no record of this permission being approved. If the session was just created, ' +
        'the grant may not have been mined yet; otherwise run `jaw session setup --x402`.'
    );
  }

  // `mismatch` is deliberately not here. It says the struct on disk does not
  // hash to the granted id, so the chain cannot be asked about this permission,
  // and nothing about the permission itself is wrong: the caps still apply and
  // payments still go through. Putting it in `problems` flipped `ready` to
  // false, which stops a script or an agent paying against a healthy session
  // over a local serialisation problem. It is reported on the permission line
  // instead.

  if (facts.outdated) {
    problems.push(
      'This session was created by an older CLI and cannot pay: its permission belongs to an address ' +
        'separate from the session key. Run `jaw session setup --x402` to recreate it.'
    );
  }

  if (!facts.hasAsset) {
    problems.push('This chain has no USDC configured, so x402 payments cannot be made on it.');
  }

  if (facts.hasAsset && facts.ownerBalance === null) {
    // Blaming the connection while the other balance rendered fine reads as a
    // contradiction, so only do it when both reads failed.
    problems.push(
      facts.payerBalance === null
        ? 'Could not read balances. Check the API key and network.'
        : `Could not read the owner balance for ${facts.ownerAddress}. The address may be malformed.`
    );
  }

  if (facts.ownerBalance !== null && Number(facts.ownerBalance) === 0) {
    // Above the reserve, because refills deliberately leave that much in the
    // payer to pay userOp fees with. Reading it back as funds sent to the wrong
    // address would tell the user to move money the CLI put there on purpose.
    const payerHoldsMoreThanItsGas =
      facts.payerBalance !== null && Number(facts.payerBalance) > (facts.payerReserve ?? 0);
    problems.push(
      payerHoldsMoreThanItsGas
        ? 'The owner account is empty but the payer holds USDC. Payments will work, but they bypass the ' +
            'permission, so the cap you granted is not applying. Move the funds to the owner.'
        : 'The owner account holds no USDC, so there is nothing to pay with.'
    );
  }

  // Before the session cap: this is the one that mirrors the permission, so when
  // both are exhausted it is the more useful thing to say, and it frees up on its
  // own rather than needing a config change.
  if (facts.periodCap != null && facts.periodSpent != null && facts.periodSpent >= facts.periodCap) {
    problems.push(
      `The granted allowance for this ${facts.periodLabel ?? 'period'} is used up. It resets at the end of ` +
        'the window, or grant a new permission with `jaw session setup --x402`.'
    );
  }

  // A limit that binds and cannot be read. `checkPolicy` refuses every payment
  // on that input, so a session reported ready over it would send an agent to a
  // command that cannot pay. Keyed on the label, which the caller
  // fills from the limit it found: a cap that is null beside a label that is
  // not is a limit that binds and whose figure nobody could parse.
  if (facts.periodLabel != null && facts.periodCap === null) {
    problems.push(
      `The granted allowance for this ${facts.periodLabel} cannot be read, so every payment is refused. ` +
        'Run `jaw session setup --x402` to grant a new permission.'
    );
  }

  if (facts.sessionCap !== null && facts.spent >= facts.sessionCap) {
    problems.push(
      'The session cap is used up. Raise it with `jaw config set x402.maxTotalPerSession <base units>` ' +
        'or start a new session.'
    );
  }

  return problems;
}
