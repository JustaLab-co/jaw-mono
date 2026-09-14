import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { PATHS } from './paths.js';
import { ensureDir } from './config.js';
import { errorMessage } from './errors.js';

/**
 * Serialize payments across processes.
 *
 * A spend cap is enforced by reading the ledger, checking the total, paying, and
 * appending the result. Seconds of network I/O sit between the read and the
 * write, so two payers that overlap in that window both see the same total, both
 * pass the cap, and both pay. The MCP server serializes its own tool calls in
 * memory, which does nothing about a second process: `jaw x402 pay --pay` next to
 * a running agent, or two agents at once.
 *
 * With a pre-funded payer the local cap is the only cap, so that window is the
 * difference between spending what was configured and spending the balance.
 *
 * The lock is a file created with `wx`, which is atomic: whoever creates it wins.
 * Everything else here is about not leaving it behind.
 */

interface LockFile {
  pid: number;
  /** Distinguishes our lock from one that replaced it after we judged it stale. */
  token: string;
  /** Epoch ms of the last heartbeat, for the age check. */
  at: number;
  /**
   * Epoch ms of acquisition, never rewritten. `at` moves with every beat, so it
   * stopped being able to answer how long the payment has actually been running,
   * which is what a waiter needs to be told when it gives up. Absent on a lock
   * from before the heartbeat, where `at` still answers it.
   */
  startedAt?: number;
  /**
   * The holder's heartbeat interval, ms. Absent means a holder that never
   * rewrites `at`, which is what a pre-heartbeat version of the CLI writes.
   */
  beatMs?: number;
}

/**
 * How long a lock may go without a heartbeat before it counts as abandoned.
 *
 * The holder rewrites `at` every `HEARTBEAT_INTERVAL_MS` while its work runs, so
 * this asks whether the holder is still making progress, not how long a payment
 * could possibly take. Answering the second question means summing the timeouts
 * on the payment path, and `upto` alone puts two 90s `awaitCall`s on it for a
 * bounded worst case of 249s: close enough to a 300s threshold that a second
 * payer arriving mid-payment breaks a live lock and lands in the critical
 * section beside it, both having read the same ledger total. A number derived
 * from a sum has to be re-derived every time a step is added.
 *
 * Three missed beats, so a momentarily busy event loop does not cost the lock.
 */
export const STALE_AFTER_MS = 90_000;

/**
 * The threshold for a holder that does not beat.
 *
 * `@jaw.id/cli` is published, so versions mix on one machine: 0.2.0 holds the
 * lock with this same shape, never rewrites `at`, and tolerates 300s. Measuring
 * it against the beat threshold would break its live lock at 90s and put two
 * payers against one cap. `beatMs` marks a holder that beats; without it the
 * question is still how long a payment can take, so the old answer stands.
 */
export const LEGACY_STALE_AFTER_MS = 300_000;

/** How often the holder rewrites `at` while its work runs. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** How long to wait for the holder before refusing. Refusing is safe; overspending is not. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;

const POLL_INTERVAL_MS = 100;

export interface LockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
  /** Overridable so a test does not have to wait out a real interval. */
  heartbeatMs?: number;
  /** Called once when the wait becomes noticeable, so a blocked CLI explains itself. */
  onWait?: (holderPid: number) => void;
}

/** Our lock, plus what the heartbeat has to remember between beats. */
interface Held {
  lock: LockFile;
  /** Beats in a row that did not land. Reset by one that does. */
  missed: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readLock(): LockFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.paymentLock, 'utf-8')) as LockFile;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.at !== 'number') return null;
    return parsed;
  } catch {
    return null; // missing, truncated, or half-written: treat as breakable
  }
}

/** Signal 0 tests for existence without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists under another user, which still counts as alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * How long an unreadable lock file has to stay unreadable before it counts as
 * torn rather than newborn.
 */
const TORN_GRACE_MS = 2_000;

/**
 * A file that does not parse is either torn by a crash mid-write, or newborn:
 * `withPaymentLock` creates it with `wx` and writes a tick later, so there is a
 * real window where the winner's own lock reads as `null`. Breaking it there
 * hands the same critical section to a second payer, which is the one thing
 * this module exists to prevent. A torn file stops advancing its mtime, a
 * newborn one is about to, so age separates them.
 */
function unreadableLockIsTorn(): boolean {
  try {
    return Date.now() - fs.statSync(PATHS.paymentLock).mtimeMs > TORN_GRACE_MS;
  } catch {
    return true; // already gone: nothing left to protect
  }
}

function isStale(lock: LockFile | null, staleAfterMs: number): boolean {
  if (!lock) return unreadableLockIsTorn(); // torn by a crash, or still being written
  if (!isAlive(lock.pid)) return true; // holder died without releasing
  // By type, not by presence: a `beatMs` that is not a number is not a promise
  // to beat, and erring long only delays a break that is already overdue.
  const beating = typeof lock.beatMs === 'number';
  const threshold = beating ? staleAfterMs : Math.max(staleAfterMs, LEGACY_STALE_AFTER_MS);
  return Date.now() - lock.at > threshold; // alive but wedged past any real payment
}

/**
 * Remove a lock only if it still looks like the one judged stale.
 *
 * Between deciding and deleting, the holder may have released and someone else
 * acquired. Comparing first keeps this from deleting a live lock and letting two
 * payers through, which is the exact failure the lock exists to prevent.
 */
function breakLock(observed: LockFile | null): void {
  const current = readLock();
  const sameLock =
    (observed === null && current === null) ||
    (observed !== null && current !== null && current.token === observed.token && current.at === observed.at);
  if (!sameLock && current !== null) return;
  // Same grace as `isStale`, for the door it does not cover: `current === null`
  // also happens when the holder released and a third payer is mid-`wx`, its
  // file created and not yet written. Unlinking there deletes a lock that payer
  // believes it holds, and both of us end up inside the critical section.
  if (current === null && !unreadableLockIsTorn()) return;
  try {
    fs.unlinkSync(PATHS.paymentLock);
  } catch {
    /* already gone: someone else broke it first, which is the same outcome */
  }
}

/** How long the holder has held the lock, for the message a waiter gives up with. */
function heldForSeconds(holder: LockFile | null): number {
  if (!holder) return 0;
  const since = typeof holder.startedAt === 'number' ? holder.startedAt : holder.at;
  return Math.round((Date.now() - since) / 1000);
}

/**
 * Hold the payment lock for the duration of `fn`.
 *
 * Held across the network call on purpose. The cap is only safe if the read, the
 * payment and the write happen as one unit, so payments are serialized machine
 * wide. They are inherently sequential for that reason, which the in-memory
 * queue in the MCP handler already assumed.
 */
export async function withPaymentLock<T>(fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const token = crypto.randomBytes(16).toString('hex');
  const beatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  ensureDir(PATHS.root);

  let notified = false;
  // The record we write and then keep alive. `at` is the only field a beat
  // moves; the rest, `startedAt` included, are fixed at acquisition.
  const held: Held = { lock: { pid: process.pid, token, at: 0, startedAt: 0, beatMs }, missed: 0 };
  for (;;) {
    try {
      const fd = fs.openSync(PATHS.paymentLock, 'wx', 0o600);
      try {
        held.lock.at = held.lock.startedAt = Date.now();
        fs.writeFileSync(fd, JSON.stringify(held.lock));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;

      const holder = readLock();
      if (isStale(holder, staleAfterMs)) {
        // Break it, then fall through to the deadline check and the sleep below
        // rather than retrying straight away. If the unlink cannot succeed (an
        // immutable file, or a directory at that path) its error is swallowed
        // and `wx` keeps returning EEXIST, so looping without yielding spins at
        // 100% CPU forever and wedges the whole process, not just the payment.
        breakLock(holder);
      } else if (!notified && holder) {
        notified = true;
        options.onWait?.(holder.pid);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Another payment has been running for ${heldForSeconds(holder)}s ` +
            `(pid ${holder?.pid ?? 'unknown'}). Refusing rather than paying past the session cap. ` +
            `Retry once it finishes, or remove ${PATHS.paymentLock} if that process is gone.`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // Registered for the duration: a kill between here and the finally would
  // otherwise leave a lock that every later payment has to wait out.
  const releaseOnExit = () => release(token);
  process.once('exit', releaseOnExit);

  // `unref` so a beat still pending cannot hold a finished command's event loop open.
  const heartbeat = setInterval(() => {
    if (!beat(held, staleAfterMs)) clearInterval(heartbeat);
  }, beatMs);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    process.removeListener('exit', releaseOnExit);
    release(token);
  }
}

/**
 * Rewrite `at` so the age check measures progress rather than a predicted duration.
 *
 * Renamed over the lock rather than written in place, because rename is atomic and
 * no reader ever sees a half-written file. Writing in place would reopen the torn
 * window `unreadableLockIsTorn` covers, once per interval instead of once at
 * creation.
 *
 * False stops the heartbeat, and means we have no claim left to refresh: the file
 * belongs to someone else, or our own `at` has aged past the point where a payer
 * reading it may take it. Writing in either case would put two payers in the
 * critical section, which is what the lock exists to prevent.
 */
function beat(held: Held, staleAfterMs: number): boolean {
  const current = readLock();
  // A read that fails says nothing about who holds the lock: EMFILE in a
  // long-lived MCP server, a truncated file, or the moment between a `wx` and
  // its write all read as null. Stopping here would end the heartbeat for the
  // rest of the work and let a waiter break a live lock. Writing here would be
  // worse, since the file may already belong to a payer that just created it,
  // so skip this beat and keep the interval alive for the next one.
  if (!current) return missedBeat(held, 'the lock cannot be read');
  if (current.token !== held.lock.token) return false;
  // Already breakable: a payer that reads the lock right now is entitled to
  // unlink it and take the file. Beating would put our timestamp back over a
  // lock we no longer have a claim to, and our own `release` would then delete
  // theirs mid-payment.
  if (Date.now() - current.at > staleAfterMs) return false;
  // Named by pid, not by token: a crash between the write and the rename leaves
  // this behind, and nothing in the CLI ever reads that directory to clean it. A
  // token is fresh per acquisition, so that would litter one file per crash; a
  // pid is reused by the OS, so the set stays bounded and the next payment from
  // the same slot overwrites it.
  const staging = `${PATHS.paymentLock}.${process.pid}`;
  try {
    // Cleared first, not just overwritten: `mode` below applies only to a write
    // that creates the file, so a leftover from an earlier crash would carry its
    // own mode through the rename and onto the lock. A leftover *directory*
    // there, which nothing else can clear, would fail every beat from here on.
    fs.rmSync(staging, { force: true, recursive: true });
    fs.writeFileSync(staging, JSON.stringify({ ...held.lock, at: Date.now() } satisfies LockFile), { mode: 0o600 });
    fs.renameSync(staging, PATHS.paymentLock);
    held.missed = 0;
    return true;
  } catch (err) {
    // A staging file left behind would carry its mode into the next beat, so
    // clear it and let that one try again.
    try {
      fs.rmSync(staging, { force: true, recursive: true });
    } catch {
      /* nothing to clean up */
    }
    // Not retried in place over the lock: that write truncates first, so under
    // the one failure both paths share, no space left, it would tear a lock that
    // is otherwise intact and lose it in two seconds instead of ninety.
    return missedBeat(held, errorMessage(err));
  }
}

/**
 * A beat that did not land, counted rather than swallowed.
 *
 * One miss is survivable and looks exactly like all of them from in here. A home
 * that is full, read-only, or out of file descriptors never lands a single beat:
 * `at` freezes and the next payer breaks a live lock with nothing anywhere
 * saying why. The threshold allows three misses, so the second is the last point
 * where saying so is still ahead of the failure, and once is enough since every
 * later beat has the same thing to say.
 *
 * Always true: a beat that did not land is a reason to try the next one, not to
 * give up the lock.
 */
function missedBeat(held: Held, why: string): boolean {
  held.missed += 1;
  if (held.missed === 2) {
    process.stderr.write(
      `[jaw] warning: the payment lock heartbeat is not landing (${why}); ` +
        `another payment may start alongside this one\n`
    );
  }
  return true;
}

/** Release only our own lock: if ours was broken as stale, the file is someone else's now. */
function release(token: string): void {
  const current = readLock();
  if (current?.token !== token) return;
  try {
    fs.unlinkSync(PATHS.paymentLock);
  } catch {
    /* already gone */
  }
}
