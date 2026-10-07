import {
  atTime,
  parseApprovalId,
  type ApprovalBody,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalState,
} from '@jaw.id/agent';
import { and, eq, gt } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { getDb } from '@/db/client';
import { approvalRequests } from '@/db/schema';

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
      requester: row.requester,
      body: parseBody(row.body),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      state: stateOf(row),
    },
    now
  );
}

export async function insertRequest(connectionId: string, request: ApprovalRequest) {
  await getDb().insert(approvalRequests).values({
    id: request.id,
    connectionId,
    account: request.account,
    chainId: request.chainId,
    requester: request.requester,
    kind: request.body.kind,
    body: request.body,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });
}

/** Scoped to one connection: another connection's id reads exactly like a missing one. */
export async function findForConnection(id: string, connectionId: string, now: Date) {
  const approvalId = parseApprovalId(id);
  if (!approvalId) return undefined;
  const [row] = await getDb()
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, approvalId), eq(approvalRequests.connectionId, connectionId)));
  return row && toRequest(row, now);
}

/** For the approval page: the id is the capability. */
export async function findById(id: string, now: Date) {
  const approvalId = parseApprovalId(id);
  if (!approvalId) return undefined;
  const [row] = await getDb().select().from(approvalRequests).where(eq(approvalRequests.id, approvalId));
  return row && toRequest(row, now);
}

/** Repeats decide's precondition in SQL, so two racing decisions cannot both land. */
export async function recordDecision(request: ApprovalRequest, now: Date): Promise<boolean> {
  const { state } = request;
  if (state.status !== 'approved' && state.status !== 'rejected') throw new Error('only a decision is recorded');
  const rows = await getDb()
    .update(approvalRequests)
    .set({ status: state.status, ...state.evidence })
    .where(
      and(
        eq(approvalRequests.id, request.id),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, now)
      )
    )
    .returning({ id: approvalRequests.id });
  return rows.length === 1;
}
