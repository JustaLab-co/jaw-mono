import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

const LOCK_NOT_AVAILABLE = '55P03';
/** How long ending a connection waits for a funding turn before it gives up. */
export const LOCK_WAIT_MS = 8_000;

const key = (connectionId: string) => `refill:${connectionId}`;

export function lockTimedOut(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return (e.code ?? e.cause?.code) === LOCK_NOT_AVAILABLE;
}

/** Serializes everything that reads and moves one connection's float, until the transaction ends. */
export async function lockFloat(tx: Tx, connectionId: string, waitMs: number): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
  // The holder waits on the chain between statements, two receipts for a disconnect.
  // A host default that ends idle transactions sooner would drop the lock mid-send.
  await tx.execute(sql`select set_config('idle_in_transaction_session_timeout', '5min', true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key(connectionId)}))`);
}

/** The same lock without waiting: false when someone else holds it. */
export async function tryLockFloat(tx: Tx, connectionId: string): Promise<boolean> {
  const [{ locked }] = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext(${key(connectionId)})) as locked`
  );
  return locked;
}

// Waiters on one connection queue here, so only the one holding the lock pins a pooled connection.
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
