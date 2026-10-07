import {
  atTime,
  parseApprovalId,
  type ApprovalBody,
  type ApprovalId,
  type ApprovalRequest,
  type ApprovalState,
  type DecisionProof,
} from '@jaw.id/agent';
import { and, count, eq, exists, gt, sql } from 'drizzle-orm';
import { isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { isLive } from '@/connections/rows';
import { getDb } from '@/db/client';
import { approvalRequests, connections, grants } from '@/db/schema';

type Row = typeof approvalRequests.$inferSelect;

function parseBody(raw: unknown): ApprovalBody {
  const body = raw as Record<string, unknown>;
  if (body.kind === 'signature' && typeof body.message === 'string')
    return { kind: 'signature', message: body.message };
  if (
    body.kind === 'budget' &&
    typeof body.spender === 'string' &&
    isAddress(body.spender) &&
    typeof body.token === 'string' &&
    isAddress(body.token) &&
    typeof body.allowance === 'string' &&
    /^[1-9][0-9]*$/.test(body.allowance) &&
    Number.isSafeInteger(body.expiry)
  ) {
    const { spender, token, allowance } = body;
    return { kind: 'budget', spender, token, allowance, expiry: body.expiry as number };
  }
  throw new Error('stored approval body is malformed');
}

function proofOf(row: Row): DecisionProof {
  if (row.permissionId) return { type: 'permission', permissionId: row.permissionId as Hex };
  return { type: 'signature', signature: row.signature as Hex, assertionRef: row.assertionRef as Hex };
}

function stateOf(row: Row): ApprovalState {
  if (row.status === 'pending') return { status: 'pending' };
  return {
    status: row.status,
    evidence: {
      previewHash: row.previewHash as Hex,
      payloadHash: row.payloadHash as Hex,
      proof: proofOf(row),
      decidedAt: row.decidedAt as Date,
    },
  };
}

function toRequest({ row, sessionAddress }: { row: Row; sessionAddress: string | null }, now: Date): ApprovalRequest {
  return atTime(
    {
      id: row.id as ApprovalId,
      account: row.account as Address,
      chainId: row.chainId,
      requester: { name: row.requester, clientId: row.requesterClientId },
      // A request comes from a token, which exists only once the session key does.
      sessionAddress: (sessionAddress ?? zeroAddress) as Address,
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

const withSession = () =>
  getDb()
    .select({ row: approvalRequests, sessionAddress: connections.sessionAddress })
    .from(approvalRequests)
    .innerJoin(connections, eq(connections.id, approvalRequests.connectionId));

export async function findForConnection(id: string, connectionId: string, now: Date) {
  const approvalId = parseApprovalId(id);
  if (!approvalId) return undefined;
  const [found] = await withSession().where(
    and(eq(approvalRequests.id, approvalId), eq(approvalRequests.connectionId, connectionId))
  );
  return found && toRequest(found, now);
}

export async function findById(id: string, now: Date) {
  const approvalId = parseApprovalId(id);
  if (!approvalId) return undefined;
  const [found] = await withSession().where(eq(approvalRequests.id, approvalId));
  return found && toRequest(found, now);
}

function proofColumns(proof: DecisionProof) {
  return proof.type === 'signature'
    ? { signature: proof.signature, assertionRef: proof.assertionRef }
    : { permissionId: proof.permissionId };
}

export type NewGrant = Omit<typeof grants.$inferInsert, 'connectionId' | 'approvalId' | 'createdAt'>;

// Repeats decide's precondition in SQL, so two racing decisions cannot both land.
export async function recordDecision(request: ApprovalRequest, grant?: NewGrant): Promise<boolean> {
  const { state } = request;
  if (state.status !== 'approved' && state.status !== 'rejected') throw new Error('only a decision is recorded');
  const { proof, ...evidence } = state.evidence;
  return getDb().transaction(async (tx) => {
    const rows = await tx
      .update(approvalRequests)
      .set({ status: state.status, ...evidence, ...proofColumns(proof) })
      .where(
        and(
          eq(approvalRequests.id, request.id),
          eq(approvalRequests.status, 'pending'),
          gt(approvalRequests.expiresAt, sql`now()`),
          exists(
            tx
              .select({ id: connections.id })
              .from(connections)
              .where(and(eq(connections.id, approvalRequests.connectionId), isLive()))
          )
        )
      )
      .returning({ connectionId: approvalRequests.connectionId });
    if (rows.length !== 1) return false;
    if (grant) {
      await tx
        .insert(grants)
        .values({ ...grant, connectionId: rows[0].connectionId, approvalId: request.id })
        .onConflictDoNothing();
    }
    return true;
  });
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
    .where(and(eq(approvalRequests.id, id), isLive()));
  return row !== undefined;
}
