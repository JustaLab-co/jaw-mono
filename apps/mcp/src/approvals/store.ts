import {
  atTime,
  parseApprovalId,
  type ApprovalBody,
  type ApprovalId,
  type ApprovalRequest,
  type AgentTypedData,
  type ApprovalState,
  type Call,
  type DecisionProof,
  type GasQuote,
  type PaymentTerms,
} from '@jaw.id/agent';
import { and, count, eq, exists, getTableColumns, gt, isNull, ne, sql } from 'drizzle-orm';
import { isAddress, isHex, zeroAddress, type Address, type Hex } from 'viem';
import { isLive } from '@/connections/rows';
import { getDb } from '@/db/client';
import { approvalRequests, connections, grants } from '@/db/schema';
import { insertOneOff, type NewOneOff, type SellerRequest } from '@/payments/store';

export const MAX_PENDING = 20;

type Row = Omit<typeof approvalRequests.$inferSelect, 'sellerRequest'>;

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
  if (body.kind === 'payment' && isPaymentTerms(body.terms)) return { kind: 'payment', terms: body.terms };
  if (body.kind === 'siwe' && typeof body.message === 'string') return { kind: 'siwe', message: body.message };
  if (body.kind === 'typed-data' && isTypedData(body.typedData))
    return { kind: 'typed-data', typedData: body.typedData };
  if (
    body.kind === 'transfer' &&
    isAddr(body.to) &&
    (body.name === undefined || typeof body.name === 'string') &&
    isAddr(body.token) &&
    isUnits(body.amount) &&
    isGasQuote(body.gas)
  ) {
    const { to, token, amount, gas } = body;
    return { kind: 'transfer', to, ...(body.name !== undefined && { name: body.name }), token, amount, gas };
  }
  if (body.kind === 'calls' && Array.isArray(body.calls) && body.calls.every(isCall) && isGasQuote(body.gas)) {
    return { kind: 'calls', calls: body.calls, gas: body.gas };
  }
  throw new Error('stored approval body is malformed');
}

const isAddr = (v: unknown): v is Address => typeof v === 'string' && isAddress(v, { strict: false });
const isUnits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

function isCall(raw: unknown): raw is Call {
  const { to, data, value } = (raw ?? {}) as Record<string, unknown>;
  return isAddr(to) && isHex(data) && isHex(value);
}

function isGasQuote(raw: unknown): raw is GasQuote {
  const { estimate, context } = (raw ?? {}) as Record<string, unknown>;
  const { token, gas } = (context ?? {}) as Record<string, unknown>;
  return isUnits(estimate) && isAddr(token) && isUnits(gas);
}

// Checked in full by typedDataRefusal before it was stored.
function isTypedData(raw: unknown): raw is AgentTypedData {
  const { types, primaryType, message } = (raw ?? {}) as Record<string, unknown>;
  return typeof types === 'object' && types !== null && typeof primaryType === 'string' && typeof message === 'object';
}

function isPaymentTerms(raw: unknown): raw is PaymentTerms {
  const { resource, requirement, nonce, validBefore } = (raw ?? {}) as Record<string, unknown>;
  const option = (requirement ?? {}) as Record<string, unknown>;
  return (
    typeof resource === 'string' &&
    URL.canParse(resource) &&
    option.scheme === 'exact' &&
    typeof option.network === 'string' &&
    typeof option.amount === 'string' &&
    /^\d+$/.test(option.amount) &&
    typeof option.asset === 'string' &&
    isAddress(option.asset, { strict: false }) &&
    typeof option.payTo === 'string' &&
    isAddress(option.payTo, { strict: false }) &&
    typeof nonce === 'string' &&
    /^0x[0-9a-f]{64}$/i.test(nonce) &&
    typeof validBefore === 'string' &&
    /^\d+$/.test(validBefore)
  );
}

function proofOf(row: Row): DecisionProof {
  if (row.permissionId) return { type: 'permission', permissionId: row.permissionId as Hex };
  if (row.callsId) return { type: 'calls', callsId: row.callsId as Hex, txHash: row.txHash as Hex };
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

/** The only reader of a payment's seller request, which `toRequest` never loads. */
export async function sellerRequestOf(id: ApprovalId): Promise<SellerRequest> {
  const [row] = await getDb()
    .select({ sellerRequest: approvalRequests.sellerRequest })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id));
  return row.sellerRequest as SellerRequest;
}

/**
 * Inserts unless the connection already has `max` requests pending. The
 * per-connection lock makes the count and the insert one step, so parallel
 * calls cannot all see room under the cap.
 */
export async function insertUnderCap(
  connectionId: string,
  request: ApprovalRequest,
  max: number,
  sellerRequest?: SellerRequest
): Promise<boolean> {
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
      sellerRequest,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    });
    return true;
  });
}

// Every column but the seller request.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { sellerRequest, ...columns } = getTableColumns(approvalRequests);

const withSession = () =>
  getDb()
    .select({ row: columns, sessionAddress: connections.sessionAddress })
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
  switch (proof.type) {
    case 'signature':
      return { signature: proof.signature, assertionRef: proof.assertionRef };
    case 'permission':
      return { permissionId: proof.permissionId };
    case 'calls':
      return { callsId: proof.callsId, txHash: proof.txHash };
  }
}

export type NewGrant = Omit<typeof grants.$inferInsert, 'connectionId' | 'approvalId' | 'createdAt'>;

/** What an approval starts in the same transaction: a budget, or the row of a one-off payment. */
export type Effect = { grant: NewGrant } | { payment: NewOneOff };

// Repeats decide's precondition in SQL, so two racing decisions cannot both land.
export async function recordDecision(request: ApprovalRequest, effect?: Effect): Promise<boolean> {
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
    const { connectionId } = rows[0];
    if (effect && 'grant' in effect) {
      // Budget decisions of one connection land one at a time, each seeing the grant the
      // previous one stored, so the newest grant is the only one left unreplaced. created_at
      // is read under the lock: now() is the transaction start, before the previous commit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${connectionId}))`);
      await tx
        .insert(grants)
        .values({ ...effect.grant, connectionId, approvalId: request.id, createdAt: sql`clock_timestamp()` })
        .onConflictDoNothing();
      // Decided here, not when the page loaded: every older budget of the connection is now to revoke.
      await tx
        .update(grants)
        .set({ replacedAt: new Date() })
        .where(
          and(
            eq(grants.connectionId, connectionId),
            ne(grants.permissionId, effect.grant.permissionId),
            isNull(grants.replacedAt)
          )
        );
    }
    if (effect && 'payment' in effect) await insertOneOff(tx, connectionId, effect.payment);
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

export async function connectionOf(id: ApprovalId): Promise<string> {
  const [row] = await getDb()
    .select({ connectionId: approvalRequests.connectionId })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id));
  return row.connectionId;
}
