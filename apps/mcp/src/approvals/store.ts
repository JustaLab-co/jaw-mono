import {
  atTime,
  parseApprovalId,
  type ApprovalBody,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalState,
} from '@jaw.id/agent';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { getDb } from '@/db/client';
import { approvalRequests, connections } from '@/db/schema';

type Row = typeof approvalRequests.$inferSelect;

function parseBody(raw: unknown): ApprovalBody {
  const body = raw as Partial<ApprovalBody>;
  if (body.kind === 'signature' && typeof body.message === 'string')
    return { kind: 'signature', message: body.message };
  throw new Error('stored approval body is malformed');
}

function stateOf(row: Row): ApprovalState {
  if (row.status === 'pending') return { status: 'pending' };
  return {
    status: row.status,
    evidence: {
      previewHash: row.previewHash as Hex,
      payloadHash: row.payloadHash as Hex,
      signature: row.signature as Hex,
      assertionRef: row.assertionRef as Hex,
      decidedAt: row.decidedAt as Date,
    },
  };
}

function toRequest(row: Row, now: Date): ApprovalRequest {
  return atTime(
    {
      id: row.id as ApprovalId,
      account: row.account as Address,
      chainId: row.chainId,
      requester: { name: row.requester, clientId: row.requesterClientId },
      body: parseBody(row.body),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      state: stateOf(row),
    },
    now
  );
}

const pendingFor = (connectionId: string) =>
  and(
    eq(approvalRequests.connectionId, connectionId),
    eq(approvalRequests.status, 'pending'),
    gt(approvalRequests.expiresAt, sql`now()`)
  );

/**
 * Inserts unless the connection already has `max` requests pending. The
 * per-connection lock makes the count and the insert one step, so parallel
 * calls cannot all see room under the cap.
 */
export async function insertUnderCap(connectionId: string, request: ApprovalRequest, max: number): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${connectionId}))`);
    const [row] = await tx.select({ n: count() }).from(approvalRequests).where(pendingFor(connectionId));
    if (row.n >= max) return false;
    await tx.insert(approvalRequests).values({
      id: request.id,
      connectionId,
      account: request.account,
      chainId: request.chainId,
      requester: request.requester.name,
      requesterClientId: request.requester.clientId,
      kind: request.body.kind,
      body: request.body,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    });
    return true;
  });
}

export async function findForConnection(id: string, connectionId: string, now: Date) {
  const approvalId = parseApprovalId(id);
  if (!approvalId) return undefined;
  const [row] = await getDb()
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, approvalId), eq(approvalRequests.connectionId, connectionId)));
  return row && toRequest(row, now);
}

export async function findById(id: string, now: Date) {
  const approvalId = parseApprovalId(id);
  if (!approvalId) return undefined;
  const [row] = await getDb().select().from(approvalRequests).where(eq(approvalRequests.id, approvalId));
  return row && toRequest(row, now);
}

// Repeats decide's precondition in SQL, so two racing decisions cannot both land.
export async function recordDecision(request: ApprovalRequest): Promise<boolean> {
  const { state } = request;
  if (state.status !== 'approved' && state.status !== 'rejected') throw new Error('only a decision is recorded');
  const rows = await getDb()
    .update(approvalRequests)
    .set({ status: state.status, ...state.evidence })
    .where(
      and(
        eq(approvalRequests.id, request.id),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, sql`now()`)
      )
    )
    .returning({ id: approvalRequests.id });
  return rows.length === 1;
}

export async function countPending(connectionId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(approvalRequests).where(pendingFor(connectionId));
  return row.n;
}

/** Whether the connection that made this request can still have it decided. */
export async function connectionLive(id: ApprovalId): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: connections.id })
    .from(approvalRequests)
    .innerJoin(connections, eq(connections.id, approvalRequests.connectionId))
    .where(and(eq(approvalRequests.id, id), eq(connections.status, 'active')));
  return row !== undefined;
}
