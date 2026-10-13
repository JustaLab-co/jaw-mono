import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, lt, not, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { getDb } from '@/db/client';
import { swaps } from '@/db/schema';
import { LEASE_MS } from '@/payments/store';

export type SwapRow = typeof swaps.$inferSelect;
export type SwapState = SwapRow['state'];
type SwapSet = PgUpdateSetSource<typeof swaps>;

export interface SwapRequest {
  originChainId: number;
  originToken: string;
  destinationChainId: number;
  destinationToken: string;
  amount: string;
  depositor: string;
  recipient: string;
}

export type SwapClaim =
  | { kind: 'run'; row: SwapRow; token: string }
  | { kind: 'stored'; row: SwapRow }
  | { kind: 'busy' }
  | { kind: 'conflict' }
  | { kind: 'open'; row: SwapRow };

export const SWAP_TRANSITIONS: [SwapState, SwapState][] = [
  ['quoting', 'quote_failed'],
  ['quoting', 'quote_rejected'],
  ['quoting', 'abandoned'],
  ['quoting', 'awaiting_owner'],
  ['awaiting_owner', 'owner_declined'],
  ['awaiting_owner', 'expired'],
  ['awaiting_owner', 'deposit_sent'],
  ['awaiting_owner', 'submitted'],
  ['awaiting_owner', 'completed'],
  ['awaiting_owner', 'refunded'],
  ['awaiting_owner', 'failed'],
  ['expired', 'deposit_sent'],
  ['expired', 'submitted'],
  ['expired', 'completed'],
  ['expired', 'refunded'],
  ['expired', 'failed'],
  ['deposit_sent', 'submitted'],
  ['submitted', 'completed'],
  ['submitted', 'refunded'],
  ['submitted', 'failed'],
];

const dbNow = sql`statement_timestamp()`;
const leaseLive = sql<boolean>`${swaps.leaseUntil} > ${dbNow}`;
const currentPayment = (where: SQL) =>
  sql`exists (select 1 from payments p
    where p.connection_id = ${swaps.connectionId} and p.idempotency_key = ${swaps.paymentKey} and ${where})`;

const lowerHex = (address: string) => (/^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address);

function swapRequestHash(r: SwapRequest): string {
  const canonical = [
    r.originChainId,
    lowerHex(r.originToken),
    r.destinationChainId,
    lowerHex(r.destinationToken),
    r.amount,
    lowerHex(r.depositor),
    lowerHex(r.recipient),
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function write(where: SQL | undefined, set: SwapSet): Promise<SwapRow | undefined> {
  const [row] = await getDb().update(swaps).set(set).where(where).returning();
  return row;
}

const newToken = () => randomBytes(16).toString('base64url');
const leaseFromNow = sql`${dbNow} + ${LEASE_MS} * interval '1 millisecond'`;

async function find(connectionId: string, key: string): Promise<SwapRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(swaps)
    .where(and(eq(swaps.connectionId, connectionId), eq(swaps.idempotencyKey, key)));
  return row;
}

async function insert(connectionId: string, key: string, hash: string, request: SwapRequest) {
  const id = `swp_${newToken()}`;
  const token = newToken();
  const [row] = await getDb()
    .insert(swaps)
    .values({
      ...request,
      id,
      connectionId,
      idempotencyKey: key,
      requestHash: hash,
      paymentKey: `swap:${id}:1`,
      leaseToken: token,
      leaseUntil: leaseFromNow,
    })
    .onConflictDoNothing()
    .returning();
  return row && { kind: 'run' as const, row, token };
}

async function freeStale(connectionId: string): Promise<void> {
  const ofConnection = eq(swaps.connectionId, connectionId);
  await write(and(ofConnection, eq(swaps.state, 'awaiting_owner'), lt(swaps.approveBy, dbNow)), { state: 'expired' });
  const paying = currentPayment(sql`(p.signed_at is not null or (p.state = 'pending' and p.lease_until > ${dbNow}))`);
  await write(and(ofConnection, eq(swaps.state, 'quoting'), not(leaseLive), not(paying)), { state: 'abandoned' });
}

async function openSwap(connectionId: string): Promise<SwapRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(swaps)
    .where(and(eq(swaps.connectionId, connectionId), inArray(swaps.state, ['quoting', 'awaiting_owner'])));
  return row;
}

async function answer(row: SwapRow, hash: string): Promise<SwapClaim> {
  if (row.requestHash !== hash) return { kind: 'conflict' };
  if (row.state !== 'quoting') return { kind: 'stored', row };
  const token = newToken();
  const taken = await write(and(eq(swaps.id, row.id), eq(swaps.state, 'quoting'), not(leaseLive)), {
    leaseToken: token,
    leaseUntil: leaseFromNow,
  });
  return taken ? { kind: 'run', row: taken, token } : { kind: 'busy' };
}

const CLAIM_PASSES = 3;

export async function claimSwap(connectionId: string, key: string, request: SwapRequest): Promise<SwapClaim> {
  const hash = swapRequestHash(request);
  for (let pass = 0; pass < CLAIM_PASSES; pass++) {
    const existing = await find(connectionId, key);
    if (existing) return answer(existing, hash);
    const inserted = await insert(connectionId, key, hash, request);
    if (inserted) return inserted;
    const raced = await find(connectionId, key);
    if (raced) return answer(raced, hash);
    await freeStale(connectionId);
    const open = await openSwap(connectionId);
    if (open) return { kind: 'open', row: open };
  }
  return { kind: 'busy' };
}

const held = (id: string, token: string) =>
  and(eq(swaps.id, id), eq(swaps.state, 'quoting'), eq(swaps.leaseToken, token), leaseLive);

export const writeHeld = (id: string, token: string, set: SwapSet) => write(held(id, token), set);

export const nextAttempt = (id: string, token: string) =>
  write(and(held(id, token), isNull(swaps.quoteId), currentPayment(sql`p.state = 'failed'`)), {
    paymentAttempt: sql`${swaps.paymentAttempt} + 1`,
    paymentKey: sql`'swap:' || ${swaps.id} || ':' || (${swaps.paymentAttempt} + 1)`,
    paymentId: null,
    code: null,
  });

export const move = (connectionId: string, id: string, from: SwapState[], to: SwapState, set: SwapSet = {}) =>
  write(and(eq(swaps.id, id), eq(swaps.connectionId, connectionId), inArray(swaps.state, from)), {
    ...set,
    state: to,
  });

export const recordCallsId = (connectionId: string, id: string, callsId: string) =>
  move(connectionId, id, ['awaiting_owner', 'expired'], 'deposit_sent', { callsId });

export async function isDepositAddressTaken(address: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: swaps.id })
    .from(swaps)
    .where(sql`lower(${swaps.depositAddress}) = ${address.toLowerCase()}`)
    .limit(1);
  return row !== undefined;
}
