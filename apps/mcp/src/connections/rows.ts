import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { isAddressEqual, type Address } from 'viem';
import { getDb, type Tx } from '@/db/client';
import { connections, oauthPayloads } from '@/db/schema';
import { log } from '@/lib/edge';
import { inTurn, tryLockFloat } from '@/payments/float-lock';
import { PAY_LIMIT_MS, topUpInFlight } from '@/payments/store';
import type { Sealed } from './seal';

export type ConnectionRow = typeof connections.$inferSelect;

export interface PendingConnection {
  id: string;
  account: Address;
  sessionAddress: Address;
  sealedKey: Sealed;
  chainId: number;
  clientId: string;
  clientName: string;
  scopes: string[];
  interactionUid: string;
  expiresAt: Date;
}

/**
 * The pending row of an interaction, stored with its session key before the wallet
 * is asked for a budget, whose prefund goes to the key's address. A retry of the
 * interaction finds the row and keeps its key. Undefined when another account
 * signed in first. Nobody can claim it until `armTicket`: its ticket hash is of
 * nothing anyone holds.
 */
export async function pendingFor(c: PendingConnection): Promise<ConnectionRow | undefined> {
  const unclaimable = createHash('sha256').update(randomBytes(32)).digest('hex');
  await getDb()
    .insert(connections)
    .values({ ...c, status: 'pending', ticketHash: unclaimable })
    .onConflictDoNothing({ target: connections.interactionUid });
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.interactionUid, c.interactionUid), eq(connections.status, 'pending')));
  return row && isAddressEqual(row.account as Address, c.account) ? row : undefined;
}

/** Makes a pending connection claimable with the ticket of its page, once the owner approved everything. */
export async function armTicket(uid: string, ticketHash: string, tx: Tx): Promise<boolean> {
  const rows = await tx
    .update(connections)
    .set({ ticketHash })
    .where(and(eq(connections.interactionUid, uid), eq(connections.status, 'pending')))
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

export async function countLive(account: Address): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(connections)
    .where(and(isLive(), ownedBy(account)));
  return row.n;
}

export async function findActive(id: string): Promise<ConnectionRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), isLive()));
  return row;
}

/**
 * The sealed session key, taken once: the first token exchange wraps it under the
 * refresh token, after which the database alone can no longer open it.
 */
export async function takeSealedKey(id: string): Promise<Sealed | undefined> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ sealedKey: connections.sealedKey })
      .from(connections)
      .where(and(eq(connections.id, id), isNotNull(connections.sealedKey)))
      .for('update');
    if (!row) return undefined;
    await tx.update(connections).set({ sealedKey: null }).where(eq(connections.id, id));
    return row.sealedKey as Sealed;
  });
}

/**
 * Atomically claims the sealed key so the reconciler and a late code exchange
 * cannot both get it. SKIP LOCKED lets the loser move on instead of blocking.
 */
export async function claimSealedKey(id: string): Promise<Sealed | undefined> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ sealedKey: connections.sealedKey })
      .from(connections)
      .where(and(eq(connections.id, id), isNotNull(connections.sealedKey)))
      .for('update', { skipLocked: true });
    if (!row) return undefined;
    await tx.update(connections).set({ sealedKey: null }).where(eq(connections.id, id));
    return row.sealedKey as Sealed;
  });
}

/** Puts the key back after a failed retire, so the next run can try again. */
export async function restoreSealedKey(id: string, key: Sealed): Promise<void> {
  await getDb()
    .update(connections)
    .set({ sealedKey: key })
    .where(and(eq(connections.id, id), isNull(connections.sealedKey)));
}

const RETRY_MS = 250;

/**
 * Ends the connection of a grant the provider destroyed, after the funding turn in
 * flight. It never refuses: the provider already deleted the tokens, so a connection
 * left live could not be ended by its client again. Past the wait it ends without
 * the float lock, but never under a top-up that may still land: that lasts at most
 * until the lease of the call that sent it.
 */
export async function revokeByGrant(grantId: string, waitMs = PAY_LIMIT_MS) {
  const active = and(eq(connections.grantId, grantId), eq(connections.status, 'active'));
  const [row] = await getDb().select({ id: connections.id }).from(connections).where(active);
  if (!row) return;
  // Taken before inTurn on purpose: time queued behind other revokes counts against the wait.
  const deadline = Date.now() + waitMs;
  // In turn with this replica's refills, and polling instead of waiting on the lock:
  // a client posting its revoke many times holds no pooled connection while it waits,
  // and the role's 10 s statement_timeout cannot cut a wait meant to last longer.
  await inTurn(row.id, async () => {
    for (;;) {
      const ended = await getDb().transaction(async (tx) => {
        const locked = await tryLockFloat(tx, row.id);
        if (!locked && Date.now() < deadline) return false;
        if (await topUpInFlight(tx, row.id)) return false;
        if (!locked) log('error', { msg: `ended connection ${row.id} without the float lock` });
        await tx.update(connections).set({ status: 'revoked', revokedAt: new Date() }).where(active);
        return true;
      });
      if (ended) return;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  });
}

export const ownedBy = (account: Address) => sql`lower(${connections.account}) = ${account.toLowerCase()}`;

/** A top-up of the connection may still land in its payer, so it was not ended. */
export class TopUpInFlight extends Error {
  constructor() {
    super('a top-up of this connection may still land in its payer');
  }
}

/**
 * Ends a connection of this account: the access token stops at the next call and
 * the refresh tokens, with the key wraps they carry, are deleted, so the session
 * key cannot be opened again. Budgets on chain are revoked separately. Undefined
 * when the account has no such connection; an ended one is returned as it is.
 * Throws TopUpInFlight while a top-up may still land in the payer.
 */
export async function endConnection(id: string, account: Address, now = new Date(), db: Tx = getDb()) {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), ownedBy(account), ne(connections.status, 'pending')))
      .for('update');
    if (!found?.grantId || found.status === 'revoked') return found;
    if (await topUpInFlight(tx, id)) throw new TopUpInFlight();
    const [ended] = await tx
      .update(connections)
      .set({ status: 'revoked', revokedAt: now })
      .where(eq(connections.id, id))
      .returning();
    await tx.delete(oauthPayloads).where(eq(oauthPayloads.grantId, found.grantId));
    return ended;
  });
}
