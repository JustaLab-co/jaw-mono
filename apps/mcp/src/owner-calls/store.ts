import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
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

async function write(where: SQL | undefined, set: CallSet): Promise<OwnerCallRow | undefined> {
  const [row] = await getDb().update(ownerCalls).set(set).where(where).returning();
  return row;
}

const ofCall = (connectionId: string, id: string, states: OwnerCallState[]) =>
  and(eq(ownerCalls.id, id), eq(ownerCalls.connectionId, connectionId), inArray(ownerCalls.state, states));

/** Null when the key or the connection's open slot is taken, 'account_busy' when the account holds `maxOpen` links. */
export async function insertOwnerCall(
  input: NewOwnerCall,
  maxOpen = Infinity
): Promise<OwnerCallRow | 'account_busy' | null> {
  return getDb().transaction(async (tx) => {
    // Links of one account land one at a time, so the count holds until the insert commits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner-calls:${input.account.toLowerCase()}`}))`);
    if ((await openForAccount(tx, input.account)) >= maxOpen) return 'account_busy';
    const [row] = await tx
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
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  });
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

/** Links still waiting on the owner across every connection of the account, apart from `except`. */
export const countOpenForAccount = (account: string, except?: string) => openForAccount(getDb(), account, except);

async function openForAccount(db: Tx, account: string, except?: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(ownerCalls)
    .where(
      and(
        sql`lower(${ownerCalls.account}) = ${account.toLowerCase()}`,
        eq(ownerCalls.state, 'awaiting_owner'),
        gt(ownerCalls.approveBy, dbNow),
        except ? ne(ownerCalls.id, except) : undefined
      )
    );
  return row.n;
}

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

export const reopenLink = (row: OwnerCallRow, walletUrl: string) =>
  write(
    and(
      ofCall(row.connectionId, row.id, ['awaiting_owner']),
      eq(ownerCalls.walletUrl, row.walletUrl),
      sql`${ownerCalls.code} is distinct from ${SEND_STARTED}`,
      gt(ownerCalls.approveBy, dbNow)
    ),
    { walletUrl, code: null }
  );

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

export const markSent = (connectionId: string, id: string, callsId: string) =>
  write(ofCall(connectionId, id, ['awaiting_owner', 'expired']), { state: 'sent', callsId, code: null });

export const conclude = (connectionId: string, id: string, state: 'landed' | 'reverted', txHash: string) =>
  write(ofCall(connectionId, id, ['sent']), { state, txHash });
