import { randomBytes } from 'node:crypto';
import type { ChainClients, ReadDeps } from '@jaw.id/agent';
import { and, desc, eq, inArray, isNotNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { getAbiItem, type Address, type Hex } from 'viem';
import { entryPoint08Abi, entryPoint08Address } from 'viem/account-abstraction';
import { getDb, type Tx } from '@/db/client';
import { sends } from '@/db/schema';
// Past any run's submit and receipt wait, so the reconciler never takes a row a live run still holds.
const SEND_LEASE_MS = 10 * 60_000;

export type SendRow = typeof sends.$inferSelect;
export interface RecordedSend {
  amount: bigint;
  periodStart: number;
}
export interface OpenSpend extends RecordedSend {
  token: string;
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

export type SendEnd =
  | { state: 'landed'; txHash: Hex; callsId?: Hex }
  | { state: 'released'; txHash?: Hex | null; callsId?: Hex };

export async function settleSends(ids: string[], end: SendEnd, tx: Tx = getDb()) {
  await tx
    .update(sends)
    .set({ ...end, finishedAt: dbNow, leaseUntil: dbNow })
    .where(and(inArray(sends.id, ids), eq(sends.state, 'open')));
}

// A run that landed can be ahead of the node a later read asks, so for this long it
// counts as held unless the logs read to the pinned block show it.
const LANDED_UNSURE_MS = SEND_LEASE_MS;

const unsure = (permission: SQL) =>
  and(
    permission,
    or(
      eq(sends.state, 'open'),
      and(
        eq(sends.state, 'landed'),
        sql`${sends.finishedAt} > ${dbNow} - ${LANDED_UNSURE_MS} * interval '1 millisecond'`
      )
    )
  );

/**
 * What runs under the grant hold that a period read may not show: the open ones and
 * the recently landed ones, less the runs `seen` names, which the logs show by the
 * block that read is pinned to.
 */
export async function heldSpends(
  permissionId: string,
  tx: Tx,
  seen: ReadonlySet<string> = new Set()
): Promise<OpenSpend[]> {
  const rows = await tx
    .select({ id: sends.id, token: sends.token, amount: sends.amount, periodStart: sends.periodStart })
    .from(sends)
    .where(unsure(eq(sends.permissionId, permissionId)));
  return rows.flatMap(({ id, token, amount, periodStart }) =>
    token && !seen.has(id) ? [{ token, amount: BigInt(amount), periodStart }] : []
  );
}

// Some RPC providers cap eth_getLogs at 500 blocks.
export const SEND_WINDOW_BLOCKS = 450n;
export const userOperationEvent = getAbiItem({ abi: entryPoint08Abi, name: 'UserOperationEvent' });

type LoggedOp = { args: { success: boolean }; transactionHash: Hex };

/** A run the EntryPoint logged lands on a success, or is released with the transaction it reverted in. */
export function endOf(logs: LoggedOp[]): SendEnd | undefined {
  if (logs.length === 0) return undefined;
  const landed = logs.find((l) => l.args.success);
  return landed
    ? { state: 'landed', txHash: landed.transactionHash }
    : { state: 'released', txHash: logs[0].transactionHash };
}

// Well under LOCK_WAIT_MS, so a slow log read cannot leave the turns queued on the float lock busy.
export const LOGGED_READ_MS = 2_000;

export interface ChainView {
  /** The block the logs were read to, and the block a period read is pinned to. */
  head: bigint;
  /** Runs whose userOp the logs show by `head`: in the period spend read there, or reverted. */
  seen: Set<string>;
  /** How the open ones among them end. */
  ends: { id: string; end: SendEnd }[];
}

/**
 * Reads the EntryPoint logs, up to the head, for this connection's runs under the
 * grant that a period read may not show. It writes nothing. A run past its block
 * window is left unseen, so it stays held, and the reconciler settles it.
 */
export async function chainView(
  connectionId: string,
  permissionId: string,
  chainId: number,
  clients: ChainClients
): Promise<ChainView | undefined> {
  const rows = await getDb()
    .select({ id: sends.id, state: sends.state, callsId: sends.callsId, fromBlock: sends.fromBlock })
    .from(sends)
    .where(
      and(
        eq(sends.connectionId, connectionId),
        // The caller's id, in whatever case it was given; the connection narrows the rows.
        unsure(sql`lower(${sends.permissionId}) = ${permissionId.toLowerCase()}`),
        eq(sends.chainId, chainId),
        isNotNull(sends.callsId)
      )
    );
  if (rows.length === 0) return undefined;
  const client = clients.publicClient(chainId);
  const head = await client.getBlockNumber();
  const inWindow = rows.filter((r) => r.fromBlock + SEND_WINDOW_BLOCKS > head);
  if (inWindow.length === 0) return undefined;
  const logs = await client.getLogs({
    address: entryPoint08Address,
    event: userOperationEvent,
    args: { userOpHash: inWindow.map((r) => r.callsId as Hex) },
    fromBlock: inWindow.reduce((min, r) => (r.fromBlock < min ? r.fromBlock : min), head),
    toBlock: head,
    strict: true,
  });
  const seen = new Set<string>();
  const ends: ChainView['ends'] = [];
  for (const row of inWindow) {
    const end = endOf(logs.filter((l) => l.args.userOpHash.toLowerCase() === row.callsId?.toLowerCase()));
    if (!end) continue;
    seen.add(row.id);
    if (row.state === 'open') ends.push({ id: row.id, end });
  }
  return { head, seen, ends };
}

// At the block the logs were read to, a run they settled is in the period spend.
// A node behind that block fails the read rather than answer without it.
export function readAt(clients: ChainClients, chainId: number, block: bigint | undefined): ReadDeps {
  if (block === undefined) return { clients };
  const client = clients.publicClient(chainId);
  return { readContract: (args) => client.readContract({ ...args, blockNumber: block } as never) };
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
