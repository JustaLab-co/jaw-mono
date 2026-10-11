import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { floatHolder, getDb, type Tx } from '@/db/client';
import { connections } from '@/db/schema';
import { log } from '@/lib/edge';

/** How long ending a connection waits for a funding turn before it gives up. */
export const LOCK_WAIT_MS = 8_000;
export const MAX_HOLDS = 16;
const SESSIONS_PER_CONNECTION = 2;

/** The wait ran out before the float lock was taken; the work never ran. */
export class FloatBusy extends Error {
  constructor(reason = 'another session held the float lock past the wait') {
    super(reason);
  }
}
/** The session holding the float lock dropped, so the lock may be someone else's now. */
export class FloatLost extends Error {
  constructor() {
    super('the session holding the float lock dropped');
  }
}

export interface FloatHold {
  /** One short transaction on the app pool. */
  tx<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** False once the lock session dropped. */
  held(): boolean;
  /** Throws FloatLost once the lock session dropped. Called right before each chain send. */
  assertHeld(): void;
}

const key = (connectionId: string) => `refill:${connectionId}`;
const sessions = new Map<string, number>();

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
  const tx = <R>(fn: (tx: Tx) => Promise<R>) => boundedTx(waitMs, fn);
  const holder = floatHolder();
  // PGlite runs one session: the queue below is all the serialization it needs.
  if (holder === 'pglite')
    return inTurn(`pglite:${connectionId}`, () => work({ tx, held: () => true, assertHeld() {} }));

  const open = sessions.get(connectionId) ?? 0;
  if (open >= SESSIONS_PER_CONNECTION) throw new FloatBusy('this connection already holds the float and has a waiter');
  sessions.set(connectionId, open + 1);
  try {
    await slots.take(deadline);
    try {
      return await hold(holder.url, connectionId, deadline, tx, work);
    } finally {
      slots.give();
    }
  } finally {
    const left = (sessions.get(connectionId) as number) - 1;
    if (left) sessions.set(connectionId, left);
    else sessions.delete(connectionId);
  }
}

async function hold<T>(
  url: string,
  connectionId: string,
  deadline: number,
  tx: FloatHold['tx'],
  work: (hold: FloatHold) => Promise<T>
): Promise<T> {
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
          set_config('idle_in_transaction_session_timeout', '5min', true)`
      )
      .catch(busyOr);
    await session`select pg_advisory_xact_lock(hashtext(${key(connectionId)}))`.catch(busyOr);
    return await work({
      tx,
      held: () => !lost,
      assertHeld() {
        if (lost) throw new FloatLost();
      },
    });
  } finally {
    // Ending the session drops the lock. Nothing else is sent on it: a statement
    // after a drop crashes the driver. onclose fires on this end too.
    released = true;
    await session.end({ timeout: 1 });
  }
}

async function boundedTx<T>(waitMs: number, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
      return work(tx);
    });
  } catch (err) {
    if (lockTimedOut(err)) throw new FloatBusy('a row this work writes stayed locked past the wait');
    throw err;
  }
}

const TOO_MANY_CLIENTS = '53300';

function busyOr(err: { code?: string }): never {
  if (lockTimedOut(err)) throw new FloatBusy();
  if (err.code === TOO_MANY_CLIENTS) {
    log('warn', { msg: 'float lock session refused: database has too many clients' });
    throw new FloatBusy('the database refused another session');
  }
  throw err;
}

function lockTimedOut(err: unknown): boolean {
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
          log('warn', { msg: 'float lock waited past its deadline for a free session' });
          reject(new FloatBusy('every float lock session on this replica stayed taken past the wait'));
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
