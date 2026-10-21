import { and, count, eq, gt, ne, sql } from 'drizzle-orm';
import { heldSince } from '@/connections/session-lease';
import { getDb, type Tx } from '@/db/client';
import { ownerCalls, permissionRequests, swaps } from '@/db/schema';

// Each open link holds a relay socket for up to its approval window, and the pool is shared by every user.
export const MAX_OPEN_PER_ACCOUNT = 3;
export const FULL = 'full';
// New owner links one connection, and one account, may open per minute.
export const LINK_RATE_LIMIT = 10;
export const ACCOUNT_LINK_RATE_LIMIT = 20;

const dbNow = sql`statement_timestamp()`;

export const linkLive = and(
  eq(permissionRequests.state, 'awaiting_owner'),
  gt(permissionRequests.approveBy, dbNow),
  gt(permissionRequests.sessionUntil, heldSince)
);

export async function countOpenLinks(account: string, except?: string, db: Tx = getDb()): Promise<number> {
  const lowered = account.toLowerCase();
  const [calls] = await db
    .select({ n: count() })
    .from(ownerCalls)
    .where(
      and(
        sql`lower(${ownerCalls.account}) = ${lowered}`,
        eq(ownerCalls.state, 'awaiting_owner'),
        gt(ownerCalls.approveBy, dbNow),
        except ? ne(ownerCalls.id, except) : undefined
      )
    );
  const [swapped] = await db
    .select({ n: count() })
    .from(swaps)
    .where(
      and(
        sql`lower(${swaps.depositor}) = ${lowered}`,
        eq(swaps.state, 'awaiting_owner'),
        gt(swaps.approveBy, dbNow),
        except ? ne(swaps.id, except) : undefined
      )
    );
  const [asked] = await db
    .select({ n: count() })
    .from(permissionRequests)
    .where(and(sql`lower(${permissionRequests.account}) = ${lowered}`, linkLive));
  return calls.n + swapped.n + asked.n;
}

/**
 * Runs `write` only while the account has a free slot. The count and the write sit
 * under one lock per account, so requests racing from different connections cannot
 * all pass the count before any of them stores its link.
 */
export function withLinkSlot<T>(
  account: string,
  except: string | undefined,
  write: (tx: Tx) => Promise<T>
): Promise<T | typeof FULL> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-links:${account.toLowerCase()}`}))`);
    if ((await countOpenLinks(account, except, tx)) >= MAX_OPEN_PER_ACCOUNT) return FULL;
    return write(tx);
  });
}
