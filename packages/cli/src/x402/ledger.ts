import * as fs from 'node:fs';
import { PATHS } from '../lib/paths.js';
import { ensureDir } from '../lib/config.js';
import {
  checkpointFigureReadable,
  errorMessage,
  spendFigureOf,
  toppedUpFigureOf,
  type PaymentLog,
  type X402LogEntry,
  type X402SettlementCorrection,
} from '@jaw.id/agent';

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
export function compactX402Log(capStarts: string[] | undefined, payer: string | undefined): void {
  try {
    // No `capStarts` means a live window could not be read, so there is no
    // instant to cut against that is known to be early enough. Folding on a
    // partial list hands back budget; a larger file until the next window rolls
    // costs nothing but the read.
    if (capStarts === undefined) return;

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

// Synchronous bodies on purpose: compaction detects a concurrent append by the
// file size before and after, which holds only while nothing yields inside it.
export const jsonlPaymentLog: PaymentLog = {
  read: async (limit) => readX402Log(limit),
  append: async (entry) => appendX402Log(entry),
  correct: async (correction) => appendX402Correction(correction),
  compact: async (capStarts, payer) => compactX402Log(capStarts, payer),
};
