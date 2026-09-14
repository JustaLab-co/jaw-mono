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
   * When the authorization expires. Read by `reconcileSettlements`, which
   * proves a payment moved nothing by finding its deadline past and its nonce
   * unconsumed, and cannot say that about entries that never stored it.
   */
  deadline?: string;
  /** Which scheme signed this, so a reconciliation knows where its nonce lives. */
  scheme?: string;
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
  /**
   * Whether anything outside the receipt has confirmed what settled.
   *
   * Absent on rows written before the field, which keep counting the amount
   * they reported: those are history, and re-reading them as ceilings would
   * jam every cap that is live today.
   */
  settlement?: SettlementState;
}

/**
 * `unverified` is every signed attempt until the chain says otherwise.
 * `verified` means a transfer of that amount was found in the transaction the
 * receipt named. `expired` means the deadline passed with the nonce
 * unconsumed, so the authorization died without moving anything.
 */
export type SettlementState = 'unverified' | 'verified' | 'expired';

/**
 * A later answer about a row that was already written.
 *
 * The ledger is append-only, so a reconciliation cannot edit the payment it is
 * about. It appends this instead, keyed by the nonce that identifies the
 * attempt on chain, and `readX402Log` folds it back on before anyone sees the
 * row. Every reader goes through there, so nothing downstream learns that
 * corrections exist.
 */
export interface X402SettlementCorrection {
  at: string;
  /** The `nonce` of the payment row this answers. Payment rows never carry it. */
  corrects: string;
  settlement: SettlementState;
  /** What the chain says moved, when it says. */
  amount?: string;
  txHash?: string;
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

  const payments: X402LogEntry[] = [];
  const corrections = new Map<string, X402SettlementCorrection>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // A line that parses to `null`, a number or a string is valid JSON and not
    // a record. `'corrects' in null` throws, and this runs on the payment path
    // where nothing catches it, so one such line broke every x402 command.
    if (typeof parsed !== 'object' || parsed === null) continue;
    // Last answer about a nonce wins: a row can go unverified, then verified,
    // and the file keeps both.
    if ('corrects' in parsed)
      corrections.set((parsed as X402SettlementCorrection).corrects, parsed as X402SettlementCorrection);
    else payments.push(parsed as X402LogEntry);
  }

  const folded = payments.map((entry) => {
    const answer = entry.nonce ? corrections.get(entry.nonce) : undefined;
    if (!answer) return entry;
    return {
      ...entry,
      settlement: answer.settlement,
      amount: answer.amount ?? entry.amount,
      txHash: answer.txHash ?? entry.txHash,
    };
  });
  // The limit counts payments, not lines: corrections are not events a user
  // asked to see.
  return limit && limit > 0 ? folded.slice(-limit) : folded;
}

/** Record a later answer about a payment already on file. Never throws, like the append above. */
export function appendX402Correction(correction: X402SettlementCorrection): void {
  try {
    ensureDir(PATHS.root);
    fs.appendFileSync(PATHS.x402Log, '\n' + JSON.stringify(correction), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    const msg = errorMessage(err);
    process.stderr.write(
      `[jaw] warning: failed to record a settlement (${msg}); the payment keeps costing its ceiling\n`
    );
  }
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
 * A paid row nobody has checked costs its ceiling for that same reason. The
 * receipt is the server's own claim about how much of its own authorization it
 * took, and a claim is not evidence of itself: a fabricated hash with one base
 * unit against a thousand-unit ceiling would otherwise buy a live authorization
 * for the difference while the caps counted one. `reconcileSettlements` brings
 * the figure down to what the chain shows, one payment later.
 *
 * A row reconciled to `expired` costs nothing. Its deadline passed with its
 * nonce unconsumed, so the authorization died where it stood.
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
  if (entry.settlement === 'expired') return 0n;
  // Named, not "anything but unverified". A value this does not recognise, from
  // a torn write or a hand edit, has to land on the ceiling below with every
  // other unreadable field, or a one-character typo turns the cap loose.
  const checked = entry.settlement === undefined || entry.settlement === 'verified';
  if (entry.status === 'paid' && checked) return parse(entry.amount);
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
