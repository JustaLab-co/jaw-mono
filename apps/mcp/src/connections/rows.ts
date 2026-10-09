import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Address } from 'viem';
import { getDb, type Tx } from '@/db/client';
import { connections, oauthPayloads } from '@/db/schema';
import { log } from '@/lib/edge';
import { inTurn, tryLockFloat } from '@/payments/float-lock';
import { PAY_LIMIT_MS } from '@/payments/store';

export type ConnectionRow = typeof connections.$inferSelect;

export interface PendingConnection {
  id: string;
  account: Address;
  chainId: number;
  clientId: string;
  clientName: string;
  scopes: string[];
  interactionUid: string;
  expiresAt: Date;
}

export async function insertPending(c: PendingConnection, ticketHash: string): Promise<boolean> {
  const rows = await getDb()
    .insert(connections)
    .values({ ...c, status: 'pending', ticketHash })
    .onConflictDoNothing({ target: connections.interactionUid })
    .returning({ id: connections.id });
  return rows.length === 1;
}

const claimable = (uid: string, ticketHash: string) =>
  and(
    eq(connections.interactionUid, uid),
    eq(connections.status, 'pending'),
    eq(connections.ticketHash, ticketHash),
    gt(connections.expiresAt, sql`now()`)
  );

export async function findClaimable(uid: string, ticketHash: string): Promise<ConnectionRow | undefined> {
  const [row] = await getDb().select().from(connections).where(claimable(uid, ticketHash));
  return row;
}

// The grant and refresh token lifetime: an active row's expires_at is when the connection ends.
export const CONNECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function activate(uid: string, ticketHash: string, grantId: string): Promise<ConnectionRow | undefined> {
  const [row] = await getDb()
    .update(connections)
    .set({
      status: 'active',
      grantId,
      ticketHash: null,
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + CONNECTION_TTL_MS),
    })
    .where(claimable(uid, ticketHash))
    .returning();
  return row;
}

/** The one definition of a usable connection: active and not past its end. */
export const isLive = () => and(eq(connections.status, 'active'), gt(connections.expiresAt, sql`now()`));

export async function findActive(id: string): Promise<ConnectionRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), isLive()));
  return row;
}

/** The session key is created at the first token exchange; false when the connection already has one. */
export async function setSessionAddress(id: string, sessionAddress: Address): Promise<boolean> {
  const rows = await getDb()
    .update(connections)
    .set({ sessionAddress })
    .where(and(eq(connections.id, id), isNull(connections.sessionAddress)))
    .returning({ id: connections.id });
  return rows.length === 1;
}

const RETRY_MS = 250;

/**
 * Ends the connection of a grant the provider destroyed, after the funding turn in
 * flight. It never refuses: the provider already deleted the tokens, so a connection
 * left live could not be ended by its client again.
 */
export async function revokeByGrant(grantId: string, waitMs = PAY_LIMIT_MS) {
  const active = and(eq(connections.grantId, grantId), eq(connections.status, 'active'));
  const end = (db: Tx) => db.update(connections).set({ status: 'revoked', revokedAt: new Date() }).where(active);
  const [row] = await getDb().select({ id: connections.id }).from(connections).where(active);
  if (!row) return;
  // Taken before inTurn on purpose: time queued behind other revokes counts against the wait.
  const deadline = Date.now() + waitMs;
  // In turn with this replica's refills, and polling instead of waiting on the lock:
  // a client posting its revoke many times holds no pooled connection while it waits,
  // and the role's 10 s statement_timeout cannot cut a wait meant to last longer.
  await inTurn(row.id, async () => {
    while (Date.now() < deadline) {
      const ended = await getDb().transaction(async (tx) => {
        if (!(await tryLockFloat(tx, row.id))) return false;
        await end(tx);
        return true;
      });
      if (ended) return;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    log('error', { msg: `ended connection ${row.id} without the float lock` });
    await end(getDb());
  });
}

export const ownedBy = (account: Address) => sql`lower(${connections.account}) = ${account.toLowerCase()}`;

/**
 * Ends a connection of this account: the access token stops at the next call and
 * the refresh tokens, with the key wraps they carry, are deleted, so the session
 * key cannot be opened again. Budgets on chain are revoked separately. Undefined
 * when the account has no such connection; an ended one is returned as it is.
 */
export async function endConnection(id: string, account: Address, now = new Date(), db: Tx = getDb()) {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), ownedBy(account), ne(connections.status, 'pending')))
      .for('update');
    if (!found?.grantId || found.status === 'revoked') return found;
    const [ended] = await tx
      .update(connections)
      .set({ status: 'revoked', revokedAt: now })
      .where(eq(connections.id, id))
      .returning();
    await tx.delete(oauthPayloads).where(eq(oauthPayloads.grantId, found.grantId));
    return ended;
  });
}
