import { and, count, eq, gt, isNotNull, ne, or, sql } from 'drizzle-orm';
import { SESSION_LIMITS } from '@/connections/relay';
import { heldSince } from '@/connections/session-lease';
import { getDb, type Tx } from '@/db/client';
import { ownerCalls, permissionRequests, swaps } from '@/db/schema';

// Each open link holds a relay socket for up to its approval window, and the pool is shared by every user.
export const MAX_OPEN_PER_ACCOUNT = 3;
// Add Funds links move no funds, so they stay out of that cap and never make a payment account_busy. Their sockets
// count toward the relay's per-account limit all the same, so they get what the cap leaves of it.
export const MAX_ADD_FUNDS_PER_ACCOUNT = SESSION_LIMITS.ownerPerAccount - MAX_OPEN_PER_ACCOUNT;
export const FULL = 'full';
// New owner links one connection, and one account, may open per minute.
export const LINK_RATE_LIMIT = 10;
export const ACCOUNT_LINK_RATE_LIMIT = 20;

const dbNow = sql`statement_timestamp()`;

export const awaitsResume = isNotNull(permissionRequests.relay);

export const linkLive = and(
  eq(permissionRequests.state, 'awaiting_owner'),
  gt(permissionRequests.approveBy, dbNow),
  or(gt(permissionRequests.sessionUntil, heldSince), awaitsResume)
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
    .where(
      and(sql`lower(${permissionRequests.account}) = ${lowered}`, ne(permissionRequests.method, 'add_funds'), linkLive)
    );
  return calls.n + swapped.n + asked.n;
}

export async function countAddFundsLinks(account: string, except?: string, db: Tx = getDb()): Promise<number> {
  const [asked] = await db
    .select({ n: count() })
    .from(permissionRequests)
    .where(
      and(
        sql`lower(${permissionRequests.account}) = ${account.toLowerCase()}`,
        eq(permissionRequests.method, 'add_funds'),
        linkLive,
        except ? ne(permissionRequests.id, except) : undefined
      )
    );
  return asked.n;
}

/** What a kind of link counts against: the account's open links, or its Add Funds links. */
export interface LinkBound {
  max: number;
  count: (account: string, except?: string, db?: Tx) => Promise<number>;
}

/**
 * Runs `write` only while the account has a free slot under `bound`. The count and
 * the write sit under one lock per account, so requests racing from different
 * connections cannot all pass the count before any of them stores its link.
 */
export function withLinkSlot<T>(
  account: string,
  except: string | undefined,
  write: (tx: Tx) => Promise<T>,
  bound: LinkBound = { max: MAX_OPEN_PER_ACCOUNT, count: countOpenLinks }
): Promise<T | typeof FULL> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-links:${account.toLowerCase()}`}))`);
    if ((await bound.count(account, except, tx)) >= bound.max) return FULL;
    return write(tx);
  });
}
