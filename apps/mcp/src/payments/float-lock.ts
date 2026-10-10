import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { getDb, holderUrl, type Tx } from '@/db/client';
import { connections } from '@/db/schema';

/** How long ending a connection waits for a funding turn before it gives up. */
export const LOCK_WAIT_MS = 8_000;
export const MAX_HOLDS = 16;

/** The wait ran out before the float lock was taken; the work never ran. */
export class FloatBusy extends Error {}
/** The session holding the float lock dropped, so the lock may be someone else's now. */
export class FloatLost extends Error {}

export interface FloatHold {
  /** One short transaction on the app pool. */
  tx<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Throws FloatLost once the lock session dropped. Called right before each chain send. */
  assertHeld(): void;
}

const key = (connectionId: string) => `refill:${connectionId}`;

/**
 * Serializes everything that reads and moves one connection's float, across
 * replicas. The lock lives in a transaction on a session of its own, outside the
 * app pool, so work waiting on the chain holds no pooled connection. `waitMs`
 * covers the wait for a session, the connect and the lock.
 */
export async function withFloat<T>(
  connectionId: string,
  waitMs: number,
  work: (hold: FloatHold) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + waitMs;
  const url = holderUrl();
  // PGlite runs one session: the queue below is all the serialization it needs.
  if (!url)
    return inTurn(`pglite:${connectionId}`, () => work({ tx: (fn) => getDb().transaction(fn), assertHeld() {} }));

  await slots.take(deadline);
  let lost = false;
  let released = false;
  const session = postgres(url, {
    max: 1,
    connect_timeout: 2,
    fetch_types: false,
    onnotice: () => {},
    onclose: () => {
      if (!released) lost = true;
    },
  });
  try {
    await session`select 1`.catch(busyOr);
    const left = deadline - Date.now();
    // A lock_timeout of 0 means no limit, not no wait.
    if (left < 1) throw new FloatBusy();
    // statement_timeout sits above lock_timeout, so a long wait is answered 55P03, not
    // canceled by the role's limit. The work waits on the chain, two receipts for a
    // disconnect, and a host default that ends idle transactions sooner would drop the lock.
    await session
      .unsafe(
        `begin;
        select set_config('lock_timeout', '${left}ms', true),
          set_config('statement_timeout', '${left + 1_000}ms', true),
          set_config('idle_in_transaction_session_timeout', '5min', true);
        select pg_advisory_xact_lock(hashtext('${key(connectionId).replaceAll("'", "''")}'))`
      )
      .catch(busyOr);
    return await work({
      tx: (fn) => getDb().transaction(fn),
      assertHeld() {
        if (lost) throw new FloatLost();
      },
    });
  } finally {
    // Ending the session drops the lock. Nothing else is sent on it: a statement
    // after a drop crashes the driver. onclose fires on this end too.
    released = true;
    await session.end({ timeout: 1 });
    slots.give();
  }
}

const TOO_MANY_CLIENTS = '53300';

function busyOr(err: { code?: string }): never {
  if (lockTimedOut(err) || err.code === TOO_MANY_CLIENTS) throw new FloatBusy();
  throw err;
}

export function lockTimedOut(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return (e.code ?? e.cause?.code) === '55P03';
}

/** The same lock without waiting: false when someone else holds it. */
export async function tryLockFloat(tx: Tx, connectionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ locked: sql<boolean>`pg_try_advisory_xact_lock(hashtext(${key(connectionId)}))` })
    .from(connections)
    .where(eq(connections.id, connectionId));
  return row.locked;
}

const slots = {
  free: MAX_HOLDS,
  waiting: [] as (() => void)[],
  take(deadline: number): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => {
          this.waiting.splice(this.waiting.indexOf(turn), 1);
          reject(new FloatBusy());
        },
        Math.max(deadline - Date.now(), 0)
      );
      this.waiting.push(turn);
    });
  },
  give() {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  },
};

const queues = new Map<string, Promise<unknown>>();

export function inTurn<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(connectionId) ?? Promise.resolve()).then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(connectionId, tail);
  void tail.then(() => queues.get(connectionId) === tail && queues.delete(connectionId));
  return run;
}
