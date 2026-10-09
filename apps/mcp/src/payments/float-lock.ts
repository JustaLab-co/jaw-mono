import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { connections } from '@/db/schema';

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
  // The holder waits on the chain between statements, two receipts for a disconnect.
  // A host default that ends idle transactions sooner would drop the lock mid-send.
  // The role's statement_timeout would cancel a longer wait before lock_timeout answers it.
  await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true),
    set_config('idle_in_transaction_session_timeout', '5min', true),
    set_config('statement_timeout', ${`${waitMs + 1_000}ms`}, true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key(connectionId)}))`);
  await tx.execute(sql`set local statement_timeout to default`);
}

/** The same lock without waiting: false when someone else holds it. */
export async function tryLockFloat(tx: Tx, connectionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ locked: sql<boolean>`pg_try_advisory_xact_lock(hashtext(${key(connectionId)}))` })
    .from(connections)
    .where(eq(connections.id, connectionId));
  return row.locked;
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
