import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Address } from 'viem';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';

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

export async function revokeByGrant(grantId: string) {
  await getDb()
    .update(connections)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(eq(connections.grantId, grantId), eq(connections.status, 'active')));
}
