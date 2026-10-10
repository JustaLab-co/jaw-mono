import { createHash, randomBytes } from 'node:crypto';
import type { SignedAuthorization, TopUpOutcome, X402LogEntry } from '@jaw.id/agent';
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Address } from 'viem';
import { getDb, type Tx } from '@/db/client';
import { EXPIRY_MARGIN_MS } from './confirm';
import { payments } from '@/db/schema';

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentState = PaymentRow['state'];

/** The time budget of one call, refill included. */
export const PAY_LIMIT_MS = 90_000;
// Longer than any call can run, so a live owner never loses its row.
export const LEASE_MS = PAY_LIMIT_MS + 30_000;

export interface PaymentRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  maxAmount?: string;
}

/** How a seller is asked again for the resource of a one-off. */
export type SellerRequest = Pick<PaymentRequest, 'method' | 'headers' | 'body'>;

/** What "the same request" means for an idempotency key. */
export function requestHash(r: PaymentRequest): string {
  const headers = Object.entries(r.headers)
    .map(([k, v]) => [k.toLowerCase(), v])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const canonical = [new URL(r.url).href, r.method, headers, r.body ?? null, r.maxAmount ?? null];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type Claim =
  | { kind: 'run'; row: PaymentRow; token: string }
  | { kind: 'resume'; row: PaymentRow; authorization: SignedAuthorization }
  | { kind: 'stored'; row: PaymentRow }
  | { kind: 'busy' }
  | { kind: 'conflict' }
  | { kind: 'no_grant' };

interface Owner {
  connectionId: string;
  payer: Address;
  /** The grant a new attempt is charged to; undefined when the connection has none. */
  permissionId: string | undefined;
}

export async function findPayment(id: string): Promise<PaymentRow | undefined> {
  const [row] = await getDb().select().from(payments).where(eq(payments.id, id));
  return row;
}

async function find(connectionId: string, key: string): Promise<PaymentRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(payments)
    .where(and(eq(payments.connectionId, connectionId), eq(payments.idempotencyKey, key)));
  return row;
}

/** A signed row nobody concluded: its proof may never have arrived, so a retry sends it again. */
export const awaitingAnswer = (row: PaymentRow) =>
  row.state === 'signed' && (row.kind === null || row.code === 'no_response');

/**
 * Opens the row for this key, or says what the existing one allows. A stored
 * row answers before the grant check, so a replay survives a grant that ended.
 */
export async function claim(owner: Owner, key: string, request: PaymentRequest): Promise<Claim> {
  const hash = requestHash(request);
  let row = await find(owner.connectionId, key);
  if (!row) {
    if (!owner.permissionId) return { kind: 'no_grant' };
    const token = randomBytes(16).toString('base64url');
    const [inserted] = await getDb()
      .insert(payments)
      .values({
        id: `pay_${randomBytes(16).toString('base64url')}`,
        connectionId: owner.connectionId,
        idempotencyKey: key,
        requestHash: hash,
        permissionId: owner.permissionId,
        payer: owner.payer.toLowerCase(),
        url: request.url,
        leaseToken: token,
        leaseUntil: new Date(Date.now() + LEASE_MS),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { kind: 'run', row: inserted, token };
    row = (await find(owner.connectionId, key)) as PaymentRow;
  }
  if (row.requestHash !== hash) return { kind: 'conflict' };
  if (awaitingAnswer(row)) return { kind: 'resume', row, authorization: row.authorization as SignedAuthorization };
  if (row.state !== 'pending') return { kind: 'stored', row };
  if (!owner.permissionId) return { kind: 'no_grant' };
  const token = randomBytes(16).toString('base64url');
  const [reclaimed] = await getDb()
    .update(payments)
    .set({
      leaseToken: token,
      leaseUntil: new Date(Date.now() + LEASE_MS),
      reserved: null,
      permissionId: owner.permissionId,
    })
    .where(and(eq(payments.id, row.id), eq(payments.state, 'pending'), lt(payments.leaseUntil, sql`now()`)))
    .returning();
  return reclaimed ? { kind: 'run', row: reclaimed, token } : { kind: 'busy' };
}

/** The row an approved one-off opens: charged to the approval, paid by the account. */
export type NewOneOff = Pick<
  typeof payments.$inferInsert,
  'id' | 'idempotencyKey' | 'requestHash' | 'approvalId' | 'payer' | 'url' | 'leaseToken' | 'leaseUntil'
>;

/** Inside the transaction that records the approval. UNIQUE(approval_id) keeps it to one row. */
export async function insertOneOff(tx: Tx, connectionId: string, row: NewOneOff): Promise<void> {
  await tx.insert(payments).values({ ...row, connectionId });
}

export async function findByApproval(approvalId: string): Promise<PaymentRow | undefined> {
  const [row] = await getDb().select().from(payments).where(eq(payments.approvalId, approvalId));
  return row;
}

/** A pending one-off whose lease lapsed, under a new token, as `claim` takes over a pending row. */
export async function reclaimOneOff(id: string): Promise<{ row: PaymentRow; token: string } | undefined> {
  const token = randomBytes(16).toString('base64url');
  const [row] = await getDb()
    .update(payments)
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(payments.id, id), eq(payments.state, 'pending'), lt(payments.leaseUntil, sql`now()`)))
    .returning();
  return row && { row, token };
}

const owned = (id: string, token: string) =>
  and(eq(payments.id, id), eq(payments.state, 'pending'), eq(payments.leaseToken, token));

/** The `onSigned` hook. Throws when the row is no longer this call's, so nothing is sent. */
export async function markSigned(id: string, token: string, a: SignedAuthorization): Promise<void> {
  const { details } = a;
  const rows = await getDb()
    .update(payments)
    .set({
      state: 'signed',
      authorization: a,
      nonce: details.nonce.toLowerCase(),
      authorized: details.authorized,
      deadline: new Date(Number(details.deadline) * 1000),
      scheme: details.scheme,
      asset: details.asset,
      network: details.network,
      payTo: details.payTo,
      signedAt: new Date(),
    })
    .where(owned(id, token))
    .returning({ id: payments.id });
  if (rows.length !== 1) throw new Error('the payment row is no longer held by this call');
}

export async function txHashTaken(payer: string, txHash: string, exceptId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.payer, payer.toLowerCase()),
        sql`lower(${payments.txHash}) = ${txHash.toLowerCase()}`,
        ne(payments.id, exceptId)
      )
    )
    .limit(1);
  return row !== undefined;
}

/** Under the refill lock: throws when the row is no longer this call's. */
export async function assertOwned(tx: Tx, id: string, token: string): Promise<void> {
  const rows = await tx.select({ id: payments.id }).from(payments).where(owned(id, token));
  if (rows.length !== 1) throw new Error('the payment row is no longer held by this call');
}

/**
 * Under the refill lock, at the end of the turn: the price this row now holds
 * against the float. A row lost meanwhile is left alone; `markSigned` refuses it.
 */
export async function reserve(tx: Tx, id: string, token: string, price: string): Promise<void> {
  await tx.update(payments).set({ reserved: price }).where(owned(id, token));
}

const traceOf = (t: { topUp?: { amount?: string; batchId?: string }; approvalBatchId?: string }) => ({
  topUpAmount: sql`coalesce(${payments.topUpAmount}, ${t.topUp?.amount ?? null})`,
  topUpBatchId: sql`coalesce(${payments.topUpBatchId}, ${t.topUp?.batchId ?? null})`,
  approvalBatchId: sql`coalesce(${payments.approvalBatchId}, ${t.approvalBatchId ?? null})`,
});

/** Under the refill lock: what moved, before the lock drops. A trace already on the row is kept. */
export async function recordTopUp(tx: Tx, id: string, funded: TopUpOutcome): Promise<void> {
  if (!funded.amount && !funded.batchId && !funded.approvalBatchId) return;
  await tx
    .update(payments)
    .set(
      traceOf({ topUp: { amount: funded.amount, batchId: funded.batchId }, approvalBatchId: funded.approvalBatchId })
    )
    .where(eq(payments.id, id));
}

const holding = sql`((${payments.state} = 'pending' and ${payments.leaseUntil} > now() and ${payments.reserved} is not null)
  or (${payments.state} in ('signed', 'unknown')
    and ${payments.deadline} > now() - ${EXPIRY_MARGIN_MS} * interval '1 millisecond'))`;

/**
 * Under the refill lock: every other row of this payer that may still take money
 * out of the float, a reservation or an authorization still inside its deadline.
 */
export async function holdingRows(tx: Tx, payer: Address, exceptId: string): Promise<PaymentRow[]> {
  return tx
    .select()
    .from(payments)
    .where(and(eq(payments.payer, payer.toLowerCase()), ne(payments.id, exceptId), holding));
}

export interface Conclusion {
  state: PaymentState;
  kind: NonNullable<PaymentRow['kind']>;
  code?: string;
  httpStatus?: number;
  amount?: string;
  txHash?: string;
  blockTime?: Date;
  topUp?: { amount?: string; batchId?: string };
  approvalBatchId?: string;
}

/**
 * Writes what the call came to: from pending under the lease, or from a signed
 * row nobody concluded yet. Returns the row as written, or nothing when another
 * call concluded it first.
 */
export async function finish(
  id: string,
  token: string,
  c: Conclusion,
  fenced: string[]
): Promise<PaymentRow | undefined> {
  const [row] = await getDb()
    .update(payments)
    .set({
      state: c.state,
      kind: c.kind,
      code: c.code ?? null,
      httpStatus: c.httpStatus ?? null,
      amount: c.amount ?? null,
      txHash: c.txHash ?? null,
      blockTime: c.blockTime ?? null,
      ...traceOf(c),
      fenced: c.state === 'signed' && c.kind !== 'paid' ? null : fenced,
      finishedAt: c.state === 'signed' ? null : new Date(),
    })
    .where(
      and(
        eq(payments.id, id),
        or(
          and(eq(payments.state, 'pending'), eq(payments.leaseToken, token)),
          and(eq(payments.state, 'signed'), or(isNull(payments.kind), eq(payments.code, 'no_response')))
        )
      )
    )
    .returning();
  return row;
}

/** The agent's ledger view of a row, so caps are counted by `spendFigureOf`, the one rule. */
export function entryOf(row: PaymentRow, now: Date): X402LogEntry {
  const base = {
    at: row.createdAt.toISOString(),
    url: row.url,
    payer: row.payer,
    permissionId: row.permissionId ?? undefined,
    topUpAmount: row.topUpAmount ?? undefined,
    topUpBatchId: row.topUpBatchId ?? undefined,
    approvalBatchId: row.approvalBatchId ?? undefined,
  };
  switch (row.state) {
    case 'pending':
      // A reservation costs its price while its lease lives, like a signature nobody has answered.
      return row.reserved !== null && row.leaseUntil > now
        ? { ...base, status: 'failed', authorized: row.reserved, settlement: 'unverified' }
        : { ...base, status: 'refused' };
    case 'signed':
    case 'unknown':
      return {
        ...base,
        status: 'failed',
        authorized: row.authorized ?? undefined,
        amount: row.amount ?? undefined,
        settlement: 'unverified',
      };
    case 'settled':
      return { ...base, status: 'paid', amount: row.amount ?? undefined, settlement: 'verified' };
    case 'failed':
      return { ...base, status: 'refused' };
  }
}

/** The rows of this permission that cost a cap something, as the agent's cap math reads them. */
export async function entriesFor(permissionId: string, now: Date, tx: Tx = getDb()): Promise<X402LogEntry[]> {
  const rows = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.permissionId, permissionId),
        or(isNull(payments.kind), ne(payments.kind, 'free')),
        or(ne(payments.state, 'failed'), sql`${payments.topUpAmount} is not null`)
      )
    );
  return rows.map((row) => entryOf(row, now));
}

/**
 * Under the refill lock: what this connection's other budgets pulled in the last
 * day. Each permission has its own counter on chain, so a newer budget would
 * otherwise start the day as if nothing had been pulled.
 */
export async function pulledUnderOtherGrants(tx: Tx, connectionId: string, permissionId: string): Promise<bigint> {
  const [row] = await tx
    .select({ pulled: sql<string>`coalesce(sum(${payments.topUpAmount}), 0)::text` })
    .from(payments)
    .where(
      and(
        eq(payments.connectionId, connectionId),
        ne(payments.permissionId, permissionId),
        sql`${payments.createdAt} > now() - interval '1 day'`
      )
    );
  return BigInt(row.pulled);
}

/** Newest first. The cursor is a payment id; the order is read from its row, at full precision. */
export async function history(connectionId: string, limit: number, before?: string) {
  const anchor = before
    ? sql`(${payments.createdAt}, ${payments.id}) < (select created_at, id from payments where id = ${before})`
    : undefined;
  return getDb()
    .select()
    .from(payments)
    .where(and(eq(payments.connectionId, connectionId), anchor))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(limit);
}

/**
 * Claims up to `limit` rows for one reconciler run: signed or unknown, signed
 * before `signedBefore`, not owned by a live call, and not claimed by another
 * run. The claim is a lease on the row, so the chain is read with no lock held.
 */
export async function claimUnresolved(signedBefore: Date, claimMs: number, limit: number): Promise<PaymentRow[]> {
  const due = getDb()
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        inArray(payments.state, ['signed', 'unknown']),
        lt(payments.signedAt, signedBefore),
        lt(payments.leaseUntil, sql`now()`),
        or(isNull(payments.reconcilingUntil), lt(payments.reconcilingUntil, sql`now()`))
      )
    )
    .orderBy(payments.signedAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  return getDb()
    .update(payments)
    .set({ reconcilingUntil: new Date(Date.now() + claimMs) })
    .where(inArray(payments.id, due))
    .returning();
}

const unresolved = (id: string) => and(eq(payments.id, id), inArray(payments.state, ['signed', 'unknown']));

export async function settle(id: string, s: { txHash?: string; blockTime?: Date; amount: bigint }) {
  await getDb()
    .update(payments)
    .set({
      state: 'settled',
      kind: 'paid',
      code: null,
      txHash: sql`coalesce(${s.txHash ?? null}, ${payments.txHash})`,
      blockTime: s.blockTime ?? null,
      amount: s.amount.toString(),
      finishedAt: new Date(),
    })
    .where(unresolved(id));
}

/** The trigger also refuses this before the deadline, whatever the caller read. */
export async function expire(id: string) {
  await getDb().update(payments).set({ state: 'failed', kind: 'failed', finishedAt: new Date() }).where(unresolved(id));
}

export async function markAlerted(id: string) {
  await getDb().update(payments).set({ alertedAt: new Date() }).where(unresolved(id));
}
