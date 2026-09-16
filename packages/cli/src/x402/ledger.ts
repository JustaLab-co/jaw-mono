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
   * Set on a row that stands in for older rows a compaction folded away. It
   * carries their totals and is counted like the paid row it is; `folded` says
   * how many it replaced. Rendering reads this, the sums do not.
   */
  kind?: 'checkpoint';
  /** How many rows a checkpoint absorbed. */
  folded?: number;
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
 *
 * `abandoned` is the one that says nothing about money: the chain was asked for
 * long enough and never answered, so we stopped asking. The row keeps costing
 * its ceiling, which is what it costs while nobody knows, and it stops holding
 * a slot in every later reconciliation. `expired` would claim the authorization
 * died with nothing moving, and that is a claim about funds this cannot make.
 */
export type SettlementState = 'unverified' | 'verified' | 'expired' | 'abandoned';

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
  // `abandoned` belongs on that ceiling deliberately and not by omission: it
  // means nobody ever learned what moved.
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
    if (entry.kind === 'checkpoint') assertCheckpointReadable(entry);
    return total + spendFigureOf(entry);
  }, 0n);
}

/**
 * Stop a payment rather than let it spend against a total known to be short.
 *
 * Everywhere else in this file an unreadable field costs one payment and reads
 * as zero, which can only leave a cap where it was or higher. A checkpoint
 * breaks that: it is worth every row it absorbed, so one that will not parse
 * takes the cap down by the whole fold, and down is the direction that hands an
 * agent budget it already spent.
 *
 * Only the spend figure. A checkpoint with no `topUpAmount` is ordinary, so
 * there is no unreadable case to tell apart there, and that meter is a floor by
 * construction with the chain as its authority.
 */
function assertCheckpointReadable(entry: X402LogEntry): void {
  if (checkpointFigureReadable(entry)) return;
  throw new Error(
    `x402 ledger has an unreadable checkpoint covering ${entry.folded ?? 'an unknown number of'} rows. ` +
      `Refusing to spend against a short total. The rows it replaced are in ${PATHS.x402LogArchive}.`
  );
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
    if (!countsIn(entry, scope)) return total;
    if (since && entry.at < since) return total;
    return total + toppedUpFigureOf(entry);
  }, 0n);
}

/**
 * What one row contributes to a top-up total.
 *
 * The other meter's `spendFigureOf`, and split out for the same reason: a
 * checkpoint has to fold rows by exactly the rule that later reads them back,
 * and two copies of that rule is how they come apart. A hand-edited amount
 * reads as zero rather than taking the cap down.
 */
export function toppedUpFigureOf(entry: X402LogEntry): bigint {
  if (!entry.topUpAmount) return 0n;
  try {
    return BigInt(entry.topUpAmount);
  } catch {
    return 0n;
  }
}

/**
 * Bytes of ledger that pile up before a payment pays to tidy it. Roughly three
 * thousand rows.
 *
 * Not a config key. There is no second case asking for one, and a threshold a
 * user can lower is a way to make every payment rewrite the file.
 */
const COMPACT_AT_BYTES = 2 * 1024 * 1024;

/** Rows left alone at the end, so `jaw x402 log` still opens on real history. */
const KEEP_TAIL = 200;

/** Rows a fold has to be worth before it earns a rewrite of the whole file. */
const FOLD_AT_LEAST = 500;

/**
 * Fold the rows below `bound` into one checkpoint per scope, and move the
 * originals to the archive.
 *
 * The file is what makes a spend cap survive a restart, so it cannot be
 * truncated: an agent that relaunched into a shorter ledger would get its
 * budget back. Folding keeps every enforced total to the base unit while the
 * row count stops following the payment count, which is what costs a payment,
 * since the whole file is read inside the lock before anything is signed.
 *
 * `capStarts` is every instant a live cap counts from, from `capWindowStarts`.
 * The cut is the earliest of them later than the oldest row on file, so that no
 * cap's `since` falls strictly inside what gets absorbed: below that instant
 * every cap either counts all of the absorbed rows or none of them, and the
 * checkpoint standing in for them lands on the same side of the same test. When
 * none is later than the oldest row, every cap counts the whole file and
 * everything but the tail folds.
 *
 * `payer` is whose rows may be folded, and it is what makes the paragraph above
 * true rather than nearly true. `capStarts` describes the windows of the payer
 * that is paying and of nobody else, so another payer's live window can sit
 * strictly inside the absorbed range: its rows from before it started would come
 * back as one checkpoint stamped after it, and that payer would read spend it
 * never made and refuse payments it should allow. A second key on one machine is
 * all that takes, which `session setup` produces whenever it does not reuse one.
 * Rows of any other payer are left alone until that payer folds its own.
 *
 * Runs after the append and inside the payment lock, so nothing is writing
 * beside it. Never throws: a ledger that could not be tidied must not fail the
 * payment that just succeeded.
 */
export function compactX402Log(capStarts: string[], payer: string | undefined): void {
  try {
    const sizeBefore = fs.statSync(PATHS.x402Log).size;
    if (sizeBefore < COMPACT_AT_BYTES) return;

    const entries = readX402Log();
    // The oldest stamp, not the first row: a clock that stepped backwards
    // between two payments leaves the file out of time order, and taking the
    // cut from the wrong end moves it past a `since` that is still counting.
    const mine = (entry: X402LogEntry) =>
      payer !== undefined && typeof entry.payer === 'string' && entry.payer.toLowerCase() === payer.toLowerCase();
    const oldest = entries.reduce<string | undefined>((earliest, entry) => {
      if (!mine(entry) || !absorbable(entry, undefined)) return earliest;
      return earliest === undefined || entry.at < earliest ? entry.at : earliest;
    }, undefined);
    const bound = oldest === undefined ? undefined : cutAbove(capStarts, oldest);
    const tailFrom = Math.max(entries.length - KEEP_TAIL, 0);
    const absorbed: X402LogEntry[] = [];
    const kept: X402LogEntry[] = [];
    entries.forEach((entry, index) => {
      if (index < tailFrom && mine(entry) && absorbable(entry, bound)) absorbed.push(entry);
      else kept.push(entry);
    });
    // Above the threshold the absorbable set does not grow again until a window
    // rolls, so a ledger that can only shed a handful of rows would pay for a
    // full read and rewrite on every payment and stay over the threshold anyway.
    if (absorbed.length < FOLD_AT_LEAST) return;

    const temp = `${PATHS.x402Log}.${process.pid}.tmp`;
    // Cleared first so the write below is a create, which is the only time
    // `mode` applies: a leftover from an earlier crash would otherwise keep its
    // own mode and carry it onto the ledger through the rename. Created 0o600
    // rather than chmod'ed afterwards, which leaves the whole payment history
    // readable to any local user for the width of that gap.
    fs.rmSync(temp, { force: true, recursive: true });
    fs.writeFileSync(temp, serializeEntries([...checkpointsFor(absorbed), ...kept]), {
      encoding: 'utf-8',
      mode: 0o600,
    });

    // The lock can be broken as stale while a payment is still running. Anything
    // appended since the read is missing from what was just built, so drop the
    // rewrite rather than lose that row. Checked before the archive and not only
    // before the rename: giving up after archiving leaves those rows in the
    // archive with the ledger still holding them, and the next fold that does
    // go through writes them a second time.
    if (fs.statSync(PATHS.x402Log).size !== sizeBefore) {
      fs.rmSync(temp, { force: true });
      return;
    }

    // Archive before the ledger is rewritten. A crash between the two leaves
    // rows in both files, which nothing sums; the other order loses them.
    fs.appendFileSync(PATHS.x402LogArchive, serializeEntries(absorbed), { encoding: 'utf-8', mode: 0o600 });

    fs.renameSync(temp, PATHS.x402Log);
  } catch (err) {
    process.stderr.write(`[jaw] warning: failed to compact x402 ledger (${errorMessage(err)})\n`);
  }
}

/**
 * Whether a checkpoint's spend figure can be read back at all.
 *
 * Exported because `sumSpentSince` refuses to total a ledger holding one that
 * cannot, which is right in front of a payment and wrong in front of a report:
 * `x402 status` is what a user runs to find out what is wrong, and it has to be
 * able to say so rather than fail with it.
 */
export function checkpointFigureReadable(entry: X402LogEntry): boolean {
  if (!entry.amount) return false;
  try {
    // `topUpAmount` as well, and for the same reason: a checkpoint carries the
    // whole fold's pulls, so one that will not parse reads as zero and hands a
    // period allowance back. The chain is the authority on that meter only
    // while it can be reached, and `currentLimitUsageOnChain` falls back to
    // this figure when it cannot.
    if (entry.topUpAmount !== undefined && BigInt(entry.topUpAmount) < 0n) return false;
    return BigInt(entry.amount) >= 0n;
  } catch {
    return false;
  }
}

/**
 * Whether a row can be folded away.
 *
 * A row with no usable timestamp cannot be, whatever the bound. `entry.at <
 * since` is false when `at` is missing, so such a row counts against every
 * window today, and folding it under a real timestamp would let a later window
 * drop it.
 *
 * Neither can a checkpoint nobody can read. Folding one reads its figure as
 * zero and buries everything it stood for, quietly, in a fold that no longer
 * looks broken. Left where it is, it keeps stopping the payments it should.
 */
function absorbable(entry: X402LogEntry, bound: string | undefined): boolean {
  if (typeof entry.at !== 'string' || entry.at === '') return false;
  if (entry.kind === 'checkpoint' && !checkpointFigureReadable(entry)) return false;
  // A row the chain has not answered yet keeps its ceiling, and a correction
  // finds it by nonce. A checkpoint carries no nonce, so folding one away makes
  // that ceiling permanent: the answer still arrives and lands on nothing.
  if (entry.settlement === 'unverified' && entry.nonce) return false;
  return bound === undefined || entry.at < bound;
}

/** The earliest instant later than `oldest`, or undefined when none is. */
function cutAbove(instants: string[], oldest: string): string | undefined {
  let cut: string | undefined;
  for (const instant of instants) {
    if (instant <= oldest) continue;
    if (cut === undefined || instant < cut) cut = instant;
  }
  return cut;
}

/**
 * One checkpoint per group of rows the reads can tell apart.
 *
 * `countsIn` routes a row by its permission and falls back to its payer, and
 * `renderSummary` totals by the decimals of its network, so rows differing in
 * any of the three cannot share a stand-in. Both figures are carried because
 * the two caps read different fields off the same row.
 *
 * `status: 'paid'` so `spendFigureOf` counts `amount` with no branch of its
 * own. `at` is the newest row absorbed and never now: a later stamp would push
 * the spend forward past a window boundary, out of the window that counted it.
 */
function checkpointsFor(absorbed: X402LogEntry[]): X402LogEntry[] {
  const groups = new Map<string, X402LogEntry[]>();
  for (const entry of absorbed) {
    const key = `${entry.permissionId ?? ''}|${entry.payer ?? ''}|${entry.network ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  return [...groups.values()].map((rows) => {
    let spent = 0n;
    let toppedUp = 0n;
    let at = rows[0].at;
    for (const row of rows) {
      spent += spendFigureOf(row);
      toppedUp += toppedUpFigureOf(row);
      if (row.at > at) at = row.at;
    }
    return {
      at,
      url: 'jaw:compacted',
      payer: rows[0].payer,
      permissionId: rows[0].permissionId,
      network: rows[0].network,
      status: 'paid' as const,
      kind: 'checkpoint' as const,
      // A checkpoint folded into a later one brings its own count with it.
      // Read as one row, a stand-in for three thousand payments reports itself
      // as a stand-in for one, which is what an agent auditing the ledger reads.
      folded: rows.reduce((total, entry) => total + (entry.kind === 'checkpoint' ? (entry.folded ?? 1) : 1), 0),
      amount: spent.toString(),
      topUpAmount: toppedUp === 0n ? undefined : toppedUp.toString(),
    };
  });
}

/**
 * Lines the way `appendX402Log` writes them: newline first, none trailing, so a
 * torn write still costs only its own record.
 */
function serializeEntries(entries: X402LogEntry[]): string {
  return entries.map((entry) => '\n' + JSON.stringify(entry)).join('');
}
