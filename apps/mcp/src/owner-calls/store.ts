import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { sessionLeaseEnd } from '@/connections/session-lease';
import { getDb, type Tx } from '@/db/client';
import { leasedRows } from '@/db/leased';
import { ownerCalls } from '@/db/schema';
import { randomToken } from '@/lib/token';

export type OwnerCallRow = typeof ownerCalls.$inferSelect;
export type OwnerCallState = OwnerCallRow['state'];
type CallSet = PgUpdateSetSource<typeof ownerCalls>;

export const SEND_STARTED = 'send_started';

export interface NewOwnerCall {
  connectionId: string;
  key: string;
  requestHash: string;
  chainId: number;
  account: string;
  calls: OwnerCallRow['calls'];
  walletUrl: string;
  approveBy: Date;
}

const dbNow = sql`statement_timestamp()`;

export const leasedCalls = leasedRows<OwnerCallRow>(ownerCalls);

async function write(where: SQL | undefined, set: CallSet, db: Tx = getDb()): Promise<OwnerCallRow | undefined> {
  const [row] = await db.update(ownerCalls).set(set).where(where).returning();
  return row;
}

const ofCall = (connectionId: string, id: string, states: OwnerCallState[]) =>
  and(eq(ownerCalls.id, id), eq(ownerCalls.connectionId, connectionId), inArray(ownerCalls.state, states));

export async function insertOwnerCall(input: NewOwnerCall, db: Tx = getDb()): Promise<OwnerCallRow | null> {
  const [row] = await db
    .insert(ownerCalls)
    .values({
      id: `oc_${randomBytes(16).toString('base64url')}`,
      connectionId: input.connectionId,
      idempotencyKey: input.key,
      requestHash: input.requestHash,
      chainId: input.chainId,
      account: input.account,
      calls: input.calls,
      walletUrl: input.walletUrl,
      approveBy: input.approveBy,
      sessionUntil: sessionLeaseEnd,
      leaseHolder: randomToken(),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

async function find(where: SQL): Promise<OwnerCallRow | undefined> {
  const [row] = await getDb().select().from(ownerCalls).where(where);
  return row;
}

export const findByKey = (connectionId: string, key: string) =>
  find(and(eq(ownerCalls.connectionId, connectionId), eq(ownerCalls.idempotencyKey, key))!);

export const findById = (connectionId: string, id: string) =>
  find(and(eq(ownerCalls.connectionId, connectionId), eq(ownerCalls.id, id))!);

export const findOpen = (connectionId: string) =>
  find(and(eq(ownerCalls.connectionId, connectionId), eq(ownerCalls.state, 'awaiting_owner'))!);

export async function hasInFlight(account: string, chainId: number, graceMs: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: ownerCalls.id })
    .from(ownerCalls)
    .where(
      and(
        sql`lower(${ownerCalls.account}) = ${account.toLowerCase()}`,
        eq(ownerCalls.chainId, chainId),
        or(eq(ownerCalls.state, 'sent'), eq(ownerCalls.code, SEND_STARTED)),
        gt(ownerCalls.approveBy, sql`${dbNow} - ${graceMs} * interval '1 millisecond'`)
      )
    )
    .limit(1);
  return row !== undefined;
}

export async function expirePast(connectionId: string): Promise<void> {
  await write(
    and(
      eq(ownerCalls.connectionId, connectionId),
      eq(ownerCalls.state, 'awaiting_owner'),
      lt(ownerCalls.approveBy, dbNow)
    ),
    { state: 'expired', relay: null }
  );
}

const lapsed = or(isNull(ownerCalls.sessionUntil), lte(ownerCalls.sessionUntil, dbNow));

const unclaimed = and(lapsed, isNull(ownerCalls.relay));

export const reopenLink = (row: OwnerCallRow, walletUrl: string, db: Tx = getDb()) =>
  write(
    and(
      ofCall(row.connectionId, row.id, ['awaiting_owner']),
      eq(ownerCalls.walletUrl, row.walletUrl),
      sql`${ownerCalls.code} is distinct from ${SEND_STARTED}`,
      gt(ownerCalls.approveBy, dbNow),
      unclaimed
    ),
    { walletUrl, code: null, sessionUntil: sessionLeaseEnd, leaseHolder: randomToken() },
    db
  );

const heldBy = (row: OwnerCallRow, states: OwnerCallState[]) =>
  and(ofCall(row.connectionId, row.id, states), leasedCalls.heldBy(row));

export const { renew: renewSession, end: endSession } = leasedCalls;

/** `unlessRejoinable` leaves a row that keeps a relay session to its next resume. */
export const setCode = (row: OwnerCallRow, code: string, { unlessRejoinable = false } = {}) =>
  write(
    and(
      heldBy(row, ['awaiting_owner']),
      sql`${ownerCalls.code} is distinct from ${SEND_STARTED}`,
      unlessRejoinable ? isNull(ownerCalls.relay) : undefined
    ),
    { code }
  );

export const decline = (row: OwnerCallRow, code: string) =>
  write(heldBy(row, ['awaiting_owner']), { state: 'owner_declined', code, relay: null });

export async function markSendStarted(row: OwnerCallRow): Promise<boolean> {
  const written = await write(
    and(
      heldBy(row, ['awaiting_owner']),
      or(isNull(ownerCalls.code), eq(ownerCalls.code, SEND_STARTED)),
      gt(ownerCalls.approveBy, dbNow)
    ),
    { code: SEND_STARTED }
  );
  return written !== undefined;
}

/**
 * `sentBlock` is the chain head when the call was sent; null when it could not be read.
 * Written by whichever run hears the calls id, holder or not: the trigger keeps it write-once.
 */
export const markSent = (row: OwnerCallRow, callsId: string, sentBlock: bigint | null = null) =>
  write(ofCall(row.connectionId, row.id, ['awaiting_owner', 'expired']), {
    state: 'sent',
    callsId,
    sentBlock,
    code: null,
    relay: null,
  });

export const conclude = (connectionId: string, id: string, state: 'landed' | 'reverted', txHash: string) =>
  write(ofCall(connectionId, id, ['sent']), { state, txHash });

/** Random order, so rows the bundler never answers cannot crowd newer ones out of a batch. */
export const sentBefore = (ageMs: number, limit: number) =>
  getDb()
    .select()
    .from(ownerCalls)
    .where(
      and(
        eq(ownerCalls.state, 'sent'),
        isNotNull(ownerCalls.callsId),
        lt(ownerCalls.updatedAt, sql`${dbNow} - ${ageMs} * interval '1 millisecond'`)
      )
    )
    .orderBy(sql`random()`)
    .limit(limit);
