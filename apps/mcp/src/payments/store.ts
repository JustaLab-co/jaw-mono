import { createHash, randomBytes } from 'node:crypto';
import type { SignedAuthorization, TopUpOutcome, X402LogEntry } from '@jaw.id/agent';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Address } from 'viem';
import { getDb } from '@/db/client';
import { payments } from '@/db/schema';

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentState = PaymentRow['state'];
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** The time budget of one call, refill included. */
export const PAY_LIMIT_MS = 90_000;
// A live owner finishes inside its budget, so its lease never needs renewing.
const LEASE_MS = PAY_LIMIT_MS + 30_000;

export interface PaymentRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  maxAmount?: string;
}

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
  /** The grant the row is charged to; undefined when the connection has none. */
  permissionId: string | undefined;
}

async function find(connectionId: string, key: string): Promise<PaymentRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(payments)
    .where(and(eq(payments.connectionId, connectionId), eq(payments.idempotencyKey, key)));
  return row;
}

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
  if (row.result !== null || row.state === 'settled' || row.state === 'failed' || row.state === 'unknown') {
    return { kind: 'stored', row };
  }
  // Resending a stored proof is safe from any number of callers: one nonce, one Idempotency-Key.
  if (row.state === 'signed') return { kind: 'resume', row, authorization: row.authorization as SignedAuthorization };
  const token = randomBytes(16).toString('base64url');
  const [reclaimed] = await getDb()
    .update(payments)
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), reserved: null })
    .where(and(eq(payments.id, row.id), eq(payments.state, 'pending'), lt(payments.leaseUntil, sql`now()`)))
    .returning();
  return reclaimed ? { kind: 'run', row: reclaimed, token } : { kind: 'busy' };
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

/** Under the refill lock: the price this row now holds against the float. */
export async function reserve(tx: Tx, id: string, token: string, price: string): Promise<void> {
  const rows = await tx
    .update(payments)
    .set({ reserved: price })
    .where(owned(id, token))
    .returning({ id: payments.id });
  if (rows.length !== 1) throw new Error('the payment row is no longer held by this call');
}

/** Under the refill lock: what moved, before the lock drops, so the next waiter counts it. */
export async function recordTopUp(tx: Tx, id: string, funded: TopUpOutcome): Promise<void> {
  if (!funded.amount && !funded.batchId && !funded.approvalBatchId) return;
  await tx
    .update(payments)
    .set({
      topUpAmount: funded.amount ?? null,
      topUpBatchId: funded.batchId ?? null,
      approvalBatchId: funded.approvalBatchId ?? null,
    })
    .where(eq(payments.id, id));
}

// What a row still holds of the payer's float: a reserved pending row while its
// lease lives, and a signed or unknown row at its ceiling until the chain answers.
const holding = sql`((${payments.state} = 'pending' and ${payments.leaseUntil} > now() and ${payments.reserved} is not null)
  or ${payments.state} in ('signed', 'unknown'))`;

/** Under the refill lock: what every other row of this payer holds. */
export async function heldByOthers(tx: Tx, payer: Address, exceptId: string): Promise<bigint> {
  const [row] = await tx
    .select({ held: sql<string>`coalesce(sum(coalesce(${payments.authorized}, ${payments.reserved})), 0)::text` })
    .from(payments)
    .where(and(eq(payments.payer, payer.toLowerCase()), sql`${payments.id} <> ${exceptId}`, holding));
  return BigInt(row.held);
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
  /** The MCP answer, stored so a replay returns it byte for byte. Absent when a retry should resume. */
  result?: unknown;
}

/** Writes what the call came to, once: from pending under the lease, or from signed while no answer is stored. */
export async function finish(id: string, token: string, c: Conclusion): Promise<boolean> {
  const rows = await getDb()
    .update(payments)
    .set({
      state: c.state,
      kind: c.kind,
      code: c.code ?? null,
      httpStatus: c.httpStatus ?? null,
      amount: c.amount ?? null,
      txHash: c.txHash ?? null,
      blockTime: c.blockTime ?? null,
      ...(c.topUp && { topUpAmount: c.topUp.amount ?? null, topUpBatchId: c.topUp.batchId ?? null }),
      ...(c.approvalBatchId && { approvalBatchId: c.approvalBatchId }),
      result: c.result ?? null,
      finishedAt: c.state === 'signed' ? null : new Date(),
    })
    .where(
      and(
        eq(payments.id, id),
        or(
          and(eq(payments.state, 'pending'), eq(payments.leaseToken, token)),
          and(eq(payments.state, 'signed'), sql`${payments.result} is null`)
        )
      )
    )
    .returning({ id: payments.id });
  return rows.length === 1;
}

/** The agent's ledger view of a row, so caps are counted by `spendFigureOf`, the one rule. */
export function entryOf(row: PaymentRow, now: Date): X402LogEntry | undefined {
  const base = {
    at: row.createdAt.toISOString(),
    url: row.url,
    payer: row.payer,
    permissionId: row.permissionId,
    topUpAmount: row.topUpAmount ?? undefined,
    topUpBatchId: row.topUpBatchId ?? undefined,
    approvalBatchId: row.approvalBatchId ?? undefined,
  };
  switch (row.state) {
    case 'pending': {
      const reserving = row.reserved !== null && row.leaseUntil > now;
      return reserving
        ? { ...base, status: 'failed', authorized: row.reserved ?? undefined, settlement: 'unverified' }
        : { ...base, status: 'refused' };
    }
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
      return row.kind === 'free'
        ? undefined
        : { ...base, status: 'paid', amount: row.amount ?? undefined, settlement: 'verified' };
    case 'failed':
      return { ...base, status: 'refused' };
  }
}

/** Every row charged to this permission, as the agent's cap math reads them. */
export async function entriesFor(permissionId: string, now: Date): Promise<X402LogEntry[]> {
  const rows = await getDb().select().from(payments).where(eq(payments.permissionId, permissionId));
  return rows.map((row) => entryOf(row, now)).filter((e): e is X402LogEntry => e !== undefined);
}

export async function history(connectionId: string, limit: number, before?: { at: Date; id: string }) {
  return getDb()
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.connectionId, connectionId),
        before &&
          or(lt(payments.createdAt, before.at), and(eq(payments.createdAt, before.at), lt(payments.id, before.id)))
      )
    )
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(limit);
}
