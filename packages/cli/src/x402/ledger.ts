import * as fs from 'node:fs';
import { PATHS } from '../lib/paths.js';
import { ensureDir } from '../lib/config.js';
import { errorMessage } from '../lib/errors.js';

/**
 * One line of the append-only x402 payment ledger (`~/.jaw/x402-log.jsonl`).
 * Every payment attempt an agent makes is recorded so spend is auditable and an
 * ambiguous settlement can be reconciled by nonce/txHash after the fact.
 */
export interface X402LogEntry {
  /** ISO timestamp of the attempt. */
  at: string;
  url: string;
  /** The paying EOA. */
  payer: string;
  /**
   * The permission this spend is charged against, which is the unit the chain
   * meters. Absent on entries written before the field existed; `countsIn`
   * charges those to their payer instead.
   */
  permissionId?: string;
  /** paid = settled; failed = signed+sent but settlement failed; refused = never signed. */
  status: 'paid' | 'failed' | 'refused';
  /**
   * What actually left the payer. Under `exact` that is the amount signed for.
   * Under `upto` the server chooses it at settlement, anywhere from zero up to
   * `authorized`, and the receipt is the only place it exists.
   */
  amount?: string;
  /**
   * The ceiling the signature authorized, which is what a live authorization is
   * worth to whoever holds it. Equal to `amount` under `exact`. Absent on
   * entries written before the field existed, where `amount` was both.
   */
  authorized?: string;
  /**
   * When the authorization expires. Recorded but not yet read: reconciling a
   * failed payment means proving its nonce was never consumed and its deadline
   * has passed, and that check cannot be written against entries that never
   * stored the deadline.
   */
  deadline?: string;
  asset?: string;
  network?: string;
  payTo?: string;
  nonce?: string;
  txHash?: string;
  /** Base units refilled into the payer through the permission, when a top-up ran. */
  topUpAmount?: string;
  /** wallet_sendCalls id of that top-up, for on-chain reconciliation. */
  topUpBatchId?: string;
  /**
   * wallet_sendCalls id of the Permit2 approval, when this payment granted one.
   * Never summed with `topUpAmount`: it moves no principal, only the gas the
   * payer was charged for it. Recorded so a userOp the user paid for is not
   * missing from the audit trail.
   */
  approvalBatchId?: string;
  /** Reason for a refused/failed attempt. */
  reason?: string;
}

/**
 * Append one entry. Never throws — logging must not break a payment.
 *
 * The newline is a PREFIX, not a suffix: a torn write (crash/ENOSPC mid-append)
 * then leaves an incomplete line that the NEXT append starts on a fresh line
 * instead of concatenating onto, so one bad write loses at most its own record,
 * never the following one too.
 *
 * A write failure is surfaced to stderr (not thrown): the caller's payment
 * still succeeds, but the operator needs to know the audit trail — and the
 * restart-time spend-cap seed that reads it — just lost an entry.
 */
export function appendX402Log(entry: X402LogEntry): void {
  try {
    ensureDir(PATHS.root);
    fs.appendFileSync(PATHS.x402Log, '\n' + JSON.stringify(entry), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    const msg = errorMessage(err);
    process.stderr.write(`[jaw] warning: failed to write x402 ledger (${msg}); spend audit/cap may undercount\n`);
  }
}

/**
 * Read the ledger, oldest first. `limit` returns only the most recent N entries.
 * Malformed lines are skipped; a missing file is an empty log.
 */
export function readX402Log(limit?: number): X402LogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(PATHS.x402Log, 'utf-8');
  } catch {
    return [];
  }
  const entries = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as X402LogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is X402LogEntry => e !== null);
  return limit && limit > 0 ? entries.slice(-limit) : entries;
}

/**
 * What one row contributes to a spend cap.
 *
 * Exported because two readers need the same answer: `jaw x402 log` reports
 * against it, and the caps enforce against it, so the number a user reads and
 * the number that refuses their next payment are the same number.
 *
 * A settled payment costs what settled. A failed one costs the ceiling it
 * authorized, because an authorization that was signed and sent stays spendable
 * up to that ceiling until its nonce is consumed or its deadline passes, and
 * nothing yet proves either. Under `exact` the two figures are equal.
 *
 * Every parse failure reads as zero and the failed case takes the larger of the
 * two, so one unparseable field cannot shrink an enforced cap: a torn write or a
 * hand edit can only ever leave the cap where it was or higher. Negatives clamp
 * for the same reason, since `BigInt('-5')` parses fine and would otherwise
 * subtract.
 */
export function spendFigureOf(entry: X402LogEntry): bigint {
  if (entry.status !== 'paid' && entry.status !== 'failed') return 0n;
  const parse = (value?: string): bigint => {
    if (!value) return 0n;
    try {
      const parsed = BigInt(value);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  };
  if (entry.status === 'paid') return parse(entry.amount);
  const ceiling = parse(entry.authorized);
  const charge = parse(entry.amount);
  return ceiling > charge ? ceiling : charge;
}

/**
 * What a spend total is counted over.
 *
 * The permission, because that is what the chain meters: one permission carries
 * one per-period allowance and every spender under it draws on the same counter.
 * Counting per payer measured each spender against its own copy of the cap, so
 * two sessions granted 10 a day spent 20 a day and no number in the product said
 * so.
 *
 * The payer is not decoration. It is the fallback for entries that predate
 * `permissionId`, and the filter reporting still needs.
 */
export interface SpendScope {
  /**
   * Omitted on purpose by the session total, which is measured against
   * `maxTotalPerSession`, the user's own ceiling rather than the chain's, and
   * spans every permission the payer has held. Set by the per-period figures,
   * which mirror an on-chain counter that a new permission resets.
   */
  permissionId?: string;
  /** The paying EOA, which is what an entry with no permission is charged to. */
  payer: string;
}

/**
 * Whether one row belongs to this scope.
 *
 * Matched on the permission when both sides name one. When either does not, the
 * payers decide: on the day this shipped every existing row had no permission,
 * and dropping them would have reset a live cap to zero and handed an agent its
 * whole allowance back mid-period. An entry with no permission is charged to the
 * payer that wrote it, which is the permission it was spending under at the time.
 *
 * Conservative in the same direction as `spendFigureOf`: it can overcount across
 * a re-grant to the same key, never undercount. The payer branch stops being
 * reached once every row carries a permission.
 */
function countsIn(entry: X402LogEntry, scope: SpendScope): boolean {
  if (scope.permissionId && entry.permissionId) {
    return entry.permissionId.toLowerCase() === scope.permissionId.toLowerCase();
  }
  return entry.payer?.toLowerCase() === scope.payer.toLowerCase();
}

/**
 * Sum settled and attempted payments in `scope` since an ISO instant (its whole
 * history when `since` is omitted).
 *
 * Takes the entries instead of reading them, so a payment that counts several
 * caps reads the file once. The caller takes its snapshot inside the payment
 * lock, where nothing else can append, and every cap for that payment counts
 * against the same rows.
 *
 * Counting from the ledger rather than an in-memory total is what makes a cap
 * survive a process restart, which an agent could otherwise relaunch its way
 * past. What each row costs is `spendFigureOf`.
 */
export function sumSpentSince(entries: X402LogEntry[], scope: SpendScope, since?: string): bigint {
  return entries.reduce((total, entry) => {
    if (!countsIn(entry, scope)) return total;
    if (since && entry.at < since) return total;
    return total + spendFigureOf(entry);
  }, 0n);
}

/**
 * Sum what was pulled through the permission in `scope` since an ISO instant
 * (its whole history when `since` is omitted).
 *
 * Distinct from `sumSpentSince` because the two meter different things: the
 * on-chain allowance is drawn down by the top-up, not by the payment it later
 * funds. With a `topUpFloat` the two run apart by whatever is still sitting in
 * the payer, so measuring the granted per-period cap by payments reads a
 * permission as having more left than it does.
 *
 * Every status counts, refusals included: the pull settled on-chain before the
 * payment it was for was ever attempted, so the allowance is gone either way.
 *
 * Takes the entries for the same reason `sumSpentSince` does.
 */
export function sumToppedUpSince(entries: X402LogEntry[], scope: SpendScope, since?: string): bigint {
  return entries.reduce((total, entry) => {
    if (!entry.topUpAmount) return total;
    if (!countsIn(entry, scope)) return total;
    if (since && entry.at < since) return total;
    try {
      return total + BigInt(entry.topUpAmount);
    } catch {
      return total; // a hand-edited amount must not take the cap down
    }
  }, 0n);
}
