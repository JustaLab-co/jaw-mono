import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { getDb, type Tx } from '@/db/client';
import { sends } from '@/db/schema';
// Past any run's submit and receipt wait, so the reconciler never takes a row a live run still holds.
const SEND_LEASE_MS = 10 * 60_000;

export type SendRow = typeof sends.$inferSelect;
export interface RecordedSend {
  amount: bigint;
  periodStart: number;
}

const dbNow = sql`statement_timestamp()`;
const twoDayPeriodsAgo = sql`now() - interval '2 days'`;

export interface NewSend {
  connectionId: string;
  idempotencyKey: string;
  requestHash: string;
  permissionId: string;
  chainId: number;
  sender: Address;
  token: Address | null;
  amount: bigint;
  periodStart: number;
  fromBlock: bigint;
}

export async function recordSend(tx: Tx, s: NewSend): Promise<string> {
  const id = `send_${randomBytes(16).toString('base64url')}`;
  await tx.insert(sends).values({
    ...s,
    id,
    sender: s.sender.toLowerCase(),
    token: s.token?.toLowerCase() ?? null,
    amount: s.amount.toString(),
    leaseUntil: sql`${dbNow} + ${SEND_LEASE_MS} * interval '1 millisecond'`,
  });
  return id;
}

export async function runOf(tx: Tx, connectionId: string, key: string): Promise<SendRow[]> {
  return tx
    .select()
    .from(sends)
    .where(and(eq(sends.connectionId, connectionId), eq(sends.idempotencyKey, key)));
}

export async function noteCallsId(tx: Tx, ids: string[], callsId: Hex): Promise<void> {
  await tx
    .update(sends)
    .set({ callsId })
    .where(and(inArray(sends.id, ids), eq(sends.state, 'open')));
}

export async function handToReconciler(ids: string[], tx: Tx = getDb(), callsId?: Hex): Promise<void> {
  await tx
    .update(sends)
    .set({ leaseUntil: dbNow, ...(callsId && { callsId }) })
    .where(and(inArray(sends.id, ids), eq(sends.state, 'open')));
}

export type SendEnd = { state: 'landed'; txHash: Hex; callsId?: Hex } | { state: 'released'; txHash?: Hex | null };

export async function settleSends(ids: string[], end: SendEnd, tx: Tx = getDb()) {
  await tx
    .update(sends)
    .set({ ...end, finishedAt: dbNow, leaseUntil: dbNow })
    .where(and(inArray(sends.id, ids), eq(sends.state, 'open')));
}

export async function openSpends(permissionId: string, tx: Tx): Promise<Map<string, bigint>> {
  const rows = await tx
    .select({ token: sends.token, amount: sends.amount })
    .from(sends)
    .where(and(eq(sends.permissionId, permissionId), eq(sends.state, 'open')));
  const spent = new Map<string, bigint>();
  for (const { token, amount } of rows) {
    if (token) spent.set(token, (spent.get(token) ?? 0n) + BigInt(amount));
  }
  return spent;
}

export async function sendHistory(connectionId: string, limit: number, before?: string): Promise<SendRow[]> {
  const anchor = before
    ? sql`(${sends.createdAt}, ${sends.id}) < (select created_at, id from sends where id = ${before} and connection_id = ${connectionId})`
    : undefined;
  return getDb()
    .select()
    .from(sends)
    .where(and(eq(sends.connectionId, connectionId), anchor))
    .orderBy(desc(sends.createdAt), desc(sends.id))
    .limit(limit);
}

export async function recordedSends(permissionId: string, tx: Tx = getDb()): Promise<RecordedSend[]> {
  const rows = await tx
    .select({ amount: sends.amount, periodStart: sends.periodStart })
    .from(sends)
    .where(
      and(
        eq(sends.permissionId, permissionId),
        ne(sends.state, 'released'),
        sql`${sends.createdAt} > ${twoDayPeriodsAgo}`
      )
    );
  return rows.map((r) => ({ amount: BigInt(r.amount), periodStart: r.periodStart }));
}

export async function claimOpenSends(claimMs: number, limit: number): Promise<SendRow[]> {
  const due = getDb()
    .select({ id: sends.id })
    .from(sends)
    .where(and(eq(sends.state, 'open'), lt(sends.leaseUntil, dbNow)))
    .orderBy(sends.createdAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  return getDb()
    .update(sends)
    .set({ leaseUntil: sql`${dbNow} + ${claimMs} * interval '1 millisecond'` })
    .where(inArray(sends.id, due))
    .returning();
}
