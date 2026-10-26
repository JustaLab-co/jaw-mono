import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, not, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { APPROVE_WITHIN_MS, config, QUOTE_MARGIN_SEC } from '@/connections/config';
import { sessionLeaseEnd } from '@/connections/session-lease';
import { getDb, type Tx } from '@/db/client';
import { leasedRows } from '@/db/leased';
import { SWAP_DEPOSIT_ADDRESS_INDEX, swaps } from '@/db/schema';
import { randomToken } from '@/lib/token';
import { LEASE_MS } from '@/payments/store';
import type { BackendState, KnownStatus } from './backend';
import type { Provider } from './check';

export type SwapRow = typeof swaps.$inferSelect;
export type SwapState = SwapRow['state'];
type SwapSet = PgUpdateSetSource<typeof swaps>;

export const providerOf = (row: SwapRow): Provider =>
  (row.quote as { provider?: Provider } | null)?.provider ?? 'aurora';

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

export const leasedSwaps = leasedRows<SwapRow>(swaps);
const leaseLive = sql<boolean>`${swaps.leaseUntil} > ${dbNow}`;

const ownerWindowMs = (ttlSec: number) => Math.min(APPROVE_WITHIN_MS, (ttlSec - QUOTE_MARGIN_SEC) * 1000);

export const approveByOf = (quotedAt: Date, ttlSec: number) => new Date(quotedAt.getTime() + ownerWindowMs(ttlSec));

const quoteStale = () =>
  sql`(${swaps.quotedAt} is null or ${swaps.quotedAt} + ${ownerWindowMs(config().swapQuoteTtlSec)} * interval '1 millisecond' <= ${dbNow})`;
const toStale: SwapSet = { state: 'quote_failed', code: 'quote_stale', leaseToken: null, leaseUntil: dbNow };

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

async function write(where: SQL | undefined, set: SwapSet, db: Tx = getDb()): Promise<SwapRow | undefined> {
  const [row] = await db.update(swaps).set(set).where(where).returning();
  return row;
}

const leaseFromNow = sql`${dbNow} + ${LEASE_MS} * interval '1 millisecond'`;

async function find(connectionId: string, key: string): Promise<SwapRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(swaps)
    .where(and(eq(swaps.connectionId, connectionId), eq(swaps.idempotencyKey, key)));
  return row;
}

async function insert(connectionId: string, key: string, hash: string, request: SwapRequest) {
  const id = `swp_${randomToken()}`;
  const token = randomToken();
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

const expirePast = (where: SQL) =>
  write(and(where, eq(swaps.state, 'awaiting_owner'), lt(swaps.approveBy, dbNow)), { state: 'expired', relay: null });

/** An Across or Relay row is not read before a send, so status expires it here rather than on a backend read. */
export const expireLapsed = async (row: SwapRow) =>
  (await expirePast(and(eq(swaps.id, row.id), eq(swaps.connectionId, row.connectionId))!)) ?? row;

async function freeStale(connectionId: string): Promise<void> {
  const ofConnection = eq(swaps.connectionId, connectionId);
  await expirePast(ofConnection);
  await write(
    and(ofConnection, eq(swaps.state, 'quoting'), not(leaseLive), isNotNull(swaps.quoteId), quoteStale()),
    toStale
  );
  await write(and(ofConnection, eq(swaps.state, 'quoting'), not(leaseLive), isNull(swaps.quoteId)), {
    state: 'abandoned',
  });
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
  if (row.state === 'awaiting_owner') return { kind: 'stored', row: (await expirePast(eq(swaps.id, row.id))) ?? row };
  if (row.state !== 'quoting') return { kind: 'stored', row };
  const token = randomToken();
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

/** Whether this key, sent now, would ask the backend for a quote rather than answer from its row. */
export async function nextStepQuotes(connectionId: string, key: string, request: SwapRequest): Promise<boolean> {
  const row = await find(connectionId, key);
  if (!row) return true;
  return row.requestHash === swapRequestHash(request) && row.state === 'quoting' && row.quoteId === null;
}

export type SwapLease = { connectionId: string; id: string; token: string };

const held = ({ connectionId, id, token }: SwapLease) =>
  and(
    eq(swaps.id, id),
    eq(swaps.connectionId, connectionId),
    eq(swaps.state, 'quoting'),
    eq(swaps.leaseToken, token),
    leaseLive
  );

export const writeHeld = (lease: SwapLease, set: SwapSet) => write(held(lease), set);

const holdingQuote = (lease: SwapLease) => and(held(lease), isNotNull(swaps.quoteId));

export const failIfStale = (lease: SwapLease) => write(and(holdingQuote(lease), quoteStale()), toStale);

export const renewQuoted = (lease: SwapLease) => write(holdingQuote(lease), { leaseUntil: leaseFromNow });

export const releaseQuoted = (lease: SwapLease, set: SwapSet, db: Tx = getDb()) =>
  write(holdingQuote(lease), { ...set, leaseToken: null, leaseUntil: dbNow }, db);

export const release = (lease: SwapLease, set: SwapSet) =>
  write(and(held(lease), isNull(swaps.quoteId)), { ...set, leaseToken: null, leaseUntil: dbNow });

const ofSwap = (connectionId: string, id: string, states: SwapState[]) =>
  and(eq(swaps.id, id), eq(swaps.connectionId, connectionId), inArray(swaps.state, states));

export const move = (connectionId: string, id: string, from: SwapState[], to: SwapState, set: SwapSet = {}) =>
  write(ofSwap(connectionId, id, from), { ...set, state: to });

export const SEND_STARTED = 'send_started';

const unsent = sql`${swaps.code} is distinct from ${SEND_STARTED}`;

const heldBy = (row: SwapRow, states: SwapState[]) =>
  and(ofSwap(row.connectionId, row.id, states), leasedSwaps.heldBy(row));

export const markSendStarted = (row: SwapRow) =>
  write(
    and(
      heldBy(row, ['awaiting_owner']),
      or(isNull(swaps.code), eq(swaps.code, SEND_STARTED)),
      gt(swaps.approveBy, dbNow)
    ),
    { code: SEND_STARTED }
  );

const lapsed = or(isNull(swaps.sessionUntil), lte(swaps.sessionUntil, dbNow));

const unclaimed = and(lapsed, isNull(swaps.relay));

export const reopenLink = (row: SwapRow, walletUrl: string, db: Tx = getDb()) =>
  write(
    and(
      ofSwap(row.connectionId, row.id, ['awaiting_owner']),
      eq(swaps.walletUrl, row.walletUrl!),
      unsent,
      gt(swaps.approveBy, dbNow),
      unclaimed
    ),
    { walletUrl, code: null, sessionUntil: sessionLeaseEnd, leaseHolder: randomToken() },
    db
  );

export const { renew: renewSession, end: endSession } = leasedSwaps;

export const decline = (row: SwapRow, code: string) =>
  write(heldBy(row, ['awaiting_owner']), { state: 'owner_declined', code, relay: null });

export const declineUnsent = async (row: SwapRow, code: string) =>
  (await write(and(heldBy(row, ['awaiting_owner']), unsent), { state: 'owner_declined', code, relay: null })) ??
  write(and(heldBy(row, ['expired']), unsent), { code });

/** Written by whichever run hears the calls id, holder or not: the trigger keeps it write-once. */
export const recordCallsId = (row: SwapRow, callsId: string) =>
  move(row.connectionId, row.id, ['awaiting_owner', 'expired'], 'deposit_sent', { callsId, code: null, relay: null });

/** `unlessRejoinable` leaves a row that keeps a relay session to its next resume. */
export const recordCode = (row: SwapRow, code: string, { unlessRejoinable = false, unlessSent = false } = {}) =>
  write(
    and(
      heldBy(row, ['awaiting_owner', 'expired']),
      unlessRejoinable ? isNull(swaps.relay) : undefined,
      unlessSent ? unsent : undefined
    ),
    { code }
  );

export const DEPOSIT_FAILED = 'deposit_failed';
export const DEPOSIT_REVERTED = 'deposit_reverted';
export const DEPOSIT_AMBIGUOUS = 'deposit_ambiguous';
export const DEPOSIT_NOT_FOUND = 'deposit_not_found';

export const recordSentCode = (connectionId: string, id: string, code: string, txHash?: string) =>
  write(ofSwap(connectionId, id, ['deposit_sent']), {
    code,
    ...(txHash && { txHash: sql`coalesce(${swaps.txHash}, ${txHash})` }),
  });

export const recordTxHash = (connectionId: string, id: string, txHash: string) =>
  write(and(ofSwap(connectionId, id, ['deposit_sent', 'submitted']), isNull(swaps.txHash)), { txHash });

export async function findById(connectionId: string, id: string): Promise<SwapRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(swaps)
    .where(and(eq(swaps.connectionId, connectionId), eq(swaps.id, id)));
  return row;
}

export async function findByQuoteId(connectionId: string, quoteId: string): Promise<SwapRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(swaps)
    .where(and(eq(swaps.connectionId, connectionId), sql`lower(${swaps.quoteId}) = ${quoteId.toLowerCase()}`));
  return row;
}

export const recordSubmit = (connectionId: string, id: string, accepted: boolean, backendState?: BackendState) =>
  write(ofSwap(connectionId, id, ['deposit_sent']), {
    submitAttempts: sql`${swaps.submitAttempts} + 1`,
    ...(accepted && { state: 'submitted', backendState }),
  });

export async function recordBackend(connectionId: string, id: string, status: KnownStatus): Promise<void> {
  const seen: SwapSet = {
    backendState: status.backendState,
    backendRawState: status.untrustedRawState ?? null,
    checkedAt: dbNow,
    ...(status.txHash && { txHash: sql`coalesce(${swaps.txHash}, ${status.txHash})` }),
  };
  const following = ofSwap(connectionId, id, ['awaiting_owner', 'expired', 'deposit_sent', 'submitted']);
  if (status.state === 'pending_deposit') {
    await write(following, seen);
    await write(and(ofSwap(connectionId, id, ['awaiting_owner']), lt(swaps.approveBy, dbNow)), {
      state: 'expired',
      relay: null,
    });
    return;
  }
  await write(following, { ...seen, state: 'submitted', code: null, relay: null });
  if (status.state !== 'submitted') await write(ofSwap(connectionId, id, ['submitted']), { state: status.state });
}

const QUOTE_KEYS = new Set([SWAP_DEPOSIT_ADDRESS_INDEX, 'swaps_quote_id_unique']);

export function quoteReused(err: unknown): boolean {
  const e = (err as { cause?: { code?: unknown; constraint_name?: unknown; constraint?: unknown } }).cause;
  return e?.code === '23505' && QUOTE_KEYS.has(String(e.constraint_name ?? e.constraint));
}
