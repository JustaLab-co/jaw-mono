import { and, eq, gt, sql } from 'drizzle-orm';
import type { Address } from 'viem';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import type { Sealed } from './seal';

export type ConnectionRow = typeof connections.$inferSelect;

export interface PendingConnection {
  id: string;
  account: Address;
  chainId: number;
  clientId: string;
  clientName: string;
  scopes: string[];
  sessionAddress: Address;
  sealedKey: Sealed;
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

export async function findActive(id: string): Promise<ConnectionRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.status, 'active'), gt(connections.expiresAt, sql`now()`)));
  return row;
}

export async function updateSealedKey(id: string, sealedKey: Sealed) {
  await getDb().update(connections).set({ sealedKey }).where(eq(connections.id, id));
}

export async function revokeByGrant(grantId: string) {
  await getDb()
    .update(connections)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(eq(connections.grantId, grantId), eq(connections.status, 'active')));
}
