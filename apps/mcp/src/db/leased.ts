import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { heldSince, sessionLeaseEnd } from '@/connections/session-lease';
import { randomToken } from '@/lib/token';
import { getDb } from './client';

type LeasedTable = PgTable & {
  id: PgColumn;
  state: PgColumn;
  approveBy: PgColumn;
  sessionUntil: PgColumn;
  relay: PgColumn;
  leaseHolder: PgColumn;
  updatedAt: PgColumn;
  resumeFailures: PgColumn;
};

/** Rejoins that may fail before a row is left to the rules of a lost link. */
export const REJOIN_TRIES = 5;
/** After a failed rejoin the row waits this long, times the failures so far, before the next try. */
const REJOIN_BACKOFF_MS = 30_000;

type Held = { id: string; leaseHolder: string | null };

/** The lease, holder and stored relay session of an owner link, alike on every table that has one. */
export function leasedRows<R extends Held>(table: LeasedTable) {
  const dbNow = sql`statement_timestamp()`;
  const awaiting = eq(table.state, 'awaiting_owner');
  const open = inArray(table.state, ['awaiting_owner', 'expired']);
  const write = async (where: SQL | undefined, set: Record<string, unknown>) => {
    const [row] = await getDb()
      .update(table)
      .set(set as never)
      .where(where)
      .returning();
    return row as R | undefined;
  };
  const heldBy = (row: R) => and(eq(table.id, row.id), eq(table.leaseHolder, row.leaseHolder!));
  const resumable = and(
    awaiting,
    gt(table.approveBy, dbNow),
    or(isNull(table.sessionUntil), lte(table.sessionUntil, heldSince)),
    isNotNull(table.relay)
  );
  const end = (row: R) => write(and(heldBy(row), open), { sessionUntil: null, relay: null });
  const failed = (row: R) =>
    write(and(heldBy(row), open), {
      sessionUntil: sql`statement_timestamp() + ${REJOIN_BACKOFF_MS} * (${table.resumeFailures} + 1) * interval '1 millisecond'`,
      resumeFailures: sql`${table.resumeFailures} + 1`,
    });
  return {
    heldBy,
    resumable,
    toResume: async (limit: number, where?: SQL) => {
      const rows = await getDb()
        .select()
        .from(table)
        .where(and(resumable, where))
        .orderBy(asc(table.updatedAt))
        .limit(limit);
      return rows as R[];
    },
    take: (row: R) =>
      write(and(eq(table.id, row.id), resumable), { leaseHolder: randomToken(), sessionUntil: sessionLeaseEnd }),
    renew: (row: R) => write(and(heldBy(row), awaiting), { sessionUntil: sessionLeaseEnd }),
    release: (row: R) => write(and(heldBy(row), open), { sessionUntil: null }),
    end,
    failed,
    /** Counts a failed rejoin and, on the last try, ends the wait for a resume. */
    miss: async (row: R) => {
      const counted = (await failed(row)) as { resumeFailures: number } | undefined;
      if (counted && counted.resumeFailures >= REJOIN_TRIES) await end(row);
    },
    saveRelay: (row: R, relay: string) => write(and(heldBy(row), awaiting), { relay }),
    holderOf: async (row: R) => {
      const [found] = await getDb().select({ holder: table.leaseHolder }).from(table).where(eq(table.id, row.id));
      return found?.holder as string | null | undefined;
    },
  };
}

export type Leased<R extends Held> = ReturnType<typeof leasedRows<R>>;
