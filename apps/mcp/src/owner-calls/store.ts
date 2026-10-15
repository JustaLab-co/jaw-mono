import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { sessionLeaseEnd } from '@/connections/session-lease';
import { getDb, type Tx } from '@/db/client';
import { ownerCalls } from '@/db/schema';

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

export async function expirePast(connectionId: string): Promise<void> {
  await write(
    and(
      eq(ownerCalls.connectionId, connectionId),
      eq(ownerCalls.state, 'awaiting_owner'),
      lt(ownerCalls.approveBy, dbNow)
    ),
    { state: 'expired' }
  );
}

/** Reopens only when no process holds the link: the lease is empty or lapsed. */
export const reopenLink = (row: OwnerCallRow, walletUrl: string, db: Tx = getDb()) =>
  write(
    and(
      ofCall(row.connectionId, row.id, ['awaiting_owner']),
      eq(ownerCalls.walletUrl, row.walletUrl),
      sql`${ownerCalls.code} is distinct from ${SEND_STARTED}`,
      gt(ownerCalls.approveBy, dbNow),
      or(isNull(ownerCalls.sessionUntil), lte(ownerCalls.sessionUntil, dbNow))
    ),
    { walletUrl, code: null, sessionUntil: sessionLeaseEnd },
    db
  );

const ofSession = (row: OwnerCallRow) =>
  and(ofCall(row.connectionId, row.id, ['awaiting_owner']), eq(ownerCalls.walletUrl, row.walletUrl));

export const renewSession = (row: OwnerCallRow) => write(ofSession(row), { sessionUntil: sessionLeaseEnd });

export const endSession = (row: OwnerCallRow) => write(ofSession(row), { sessionUntil: null });

export const setCode = (connectionId: string, id: string, code: string) =>
  write(and(ofCall(connectionId, id, ['awaiting_owner']), sql`${ownerCalls.code} is distinct from ${SEND_STARTED}`), {
    code,
  });

export const decline = (connectionId: string, id: string, code: string) =>
  write(ofCall(connectionId, id, ['awaiting_owner']), { state: 'owner_declined', code });

export async function markSendStarted(connectionId: string, id: string): Promise<boolean> {
  const row = await write(
    and(ofCall(connectionId, id, ['awaiting_owner']), isNull(ownerCalls.code), gt(ownerCalls.approveBy, dbNow)),
    { code: SEND_STARTED }
  );
  return row !== undefined;
}

/** `sentBlock` is the chain head when the call was sent; null when it could not be read. */
export const markSent = (connectionId: string, id: string, callsId: string, sentBlock: bigint | null = null) =>
  write(ofCall(connectionId, id, ['awaiting_owner', 'expired']), { state: 'sent', callsId, sentBlock, code: null });

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
