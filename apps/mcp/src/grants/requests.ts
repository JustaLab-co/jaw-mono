import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { WalletBusy, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { keepLease, sessionLeaseEnd } from '@/connections/session-lease';
import { USER_REJECTED } from '@/connections/wallet-codes';
import { getDb, type Tx } from '@/db/client';
import { permissionRequests } from '@/db/schema';
import { errorLabel, log } from '@/lib/edge';
import { countOpenLinks, FULL, linkLive, MAX_OPEN_PER_ACCOUNT, withLinkSlot } from '@/owner-calls/cap';

export type PermissionRequestRow = typeof permissionRequests.$inferSelect;
type Method = PermissionRequestRow['method'];

/**
 * How a request ended, as the owner's wallet and the chain told it. A grant keeps
 * the id the wallet answered even when it was not recorded, so it can be revoked.
 */
export type Outcome =
  | { state: 'approved'; permissionId?: string }
  | { state: 'owner_declined' | 'expired' | 'failed'; code: string | null; permissionId?: string };

const dbNow = sql`statement_timestamp()`;
const awaiting = eq(permissionRequests.state, 'awaiting_owner');

/** The requests one request competes with: one grant per connection, one revoke per permission. */
const sameAs = (t: Tenant, method: Method, permissionId?: string) =>
  method === 'grant'
    ? and(eq(permissionRequests.method, 'grant'), eq(permissionRequests.connectionId, t.connectionId))
    : and(
        eq(permissionRequests.method, 'revoke'),
        sql`lower(${permissionRequests.permissionId}) = ${permissionId!.toLowerCase()}`
      );

async function update(where: SQL | undefined, set: PgUpdateSetSource<typeof permissionRequests>, db: Tx = getDb()) {
  const [row] = await db
    .update(permissionRequests)
    .set({ ...set, updatedAt: sql`statement_timestamp()` })
    .where(where)
    .returning();
  return row;
}

/** Ends waiting rows nobody can answer any more, so they stop holding the one-open slot. */
const closeDead = (same: SQL | undefined, db: Tx = getDb()) =>
  update(
    and(
      same,
      awaiting,
      or(
        lte(permissionRequests.approveBy, dbNow),
        isNull(permissionRequests.sessionUntil),
        lte(permissionRequests.sessionUntil, dbNow)
      )
    ),
    { state: 'expired', code: sql`case when ${permissionRequests.approveBy} > ${dbNow} then 'session_lost' end` },
    db
  );

async function findLive(same: SQL | undefined): Promise<PermissionRequestRow | undefined> {
  const [row] = await getDb().select().from(permissionRequests).where(and(same, linkLive));
  return row;
}

const ofRow = (row: PermissionRequestRow) => and(eq(permissionRequests.id, row.id), awaiting);

function outcomeOf(err: unknown, row: PermissionRequestRow): Outcome {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === USER_REJECTED) return { state: 'owner_declined', code: null };
  if (typeof code === 'number') return { state: 'failed', code: `wallet_error:${code}` };
  if (Date.now() >= row.approveBy.getTime()) return { state: 'expired', code: null };
  return { state: 'failed', code: 'unexpected' };
}

async function settle(row: PermissionRequestRow, outcome: Outcome) {
  const { state, permissionId } = outcome;
  const code = 'code' in outcome ? outcome.code : null;
  await update(ofRow(row), { state, code, sessionUntil: null, ...(permissionId && { permissionId }) });
}

export type Opened =
  | { opened: PermissionRequestRow }
  | { waiting: PermissionRequestRow }
  | 'account_busy'
  | 'wallet_busy';

export interface LinkRequest {
  method: Method;
  chainId: number;
  /** The permission a revoke is about. */
  permissionId?: string;
  /** Talks to the owner's wallet once the link is open, and says how it ended. */
  work: (ask: Ask) => Promise<Outcome>;
}

/**
 * Opens an owner link for a grant or a revoke, counted in the account's link cap
 * with owner calls and swaps. A link already waiting for the same thing is
 * handed back instead of opening another.
 */
export async function openLink(t: Tenant, req: LinkRequest, openWallet: OpenWallet): Promise<Opened> {
  const same = sameAs(t, req.method, req.permissionId);
  const waiting = await findLive(same);
  if (waiting) return { waiting };
  if ((await countOpenLinks(t.account)) >= MAX_OPEN_PER_ACCOUNT) return 'account_busy';
  const approveBy = new Date(Date.now() + APPROVE_WITHIN_MS);
  let wallet: Wallet;
  try {
    wallet = await openWallet(req.chainId, approveBy, t);
  } catch (err) {
    if (err instanceof WalletBusy) return 'wallet_busy';
    throw err;
  }
  let row: PermissionRequestRow | undefined | typeof FULL;
  try {
    row = await withLinkSlot(t.account, undefined, async (tx) => {
      await closeDead(same, tx);
      const [inserted] = await tx
        .insert(permissionRequests)
        .values({
          id: `pr_${randomBytes(16).toString('base64url')}`,
          connectionId: t.connectionId,
          method: req.method,
          chainId: req.chainId,
          account: t.account,
          permissionId: req.permissionId,
          walletUrl: wallet.url,
          approveBy,
          sessionUntil: sessionLeaseEnd,
        })
        .onConflictDoNothing()
        .returning();
      return inserted;
    });
  } finally {
    if (!row || row === FULL) wallet.close();
  }
  if (row === FULL) return 'account_busy';
  if (!row) {
    const raced = await findLive(same);
    return raced ? { waiting: raced } : 'wallet_busy';
  }
  follow(row, wallet, req.work);
  return { opened: row };
}

function follow(row: PermissionRequestRow, wallet: Wallet, work: LinkRequest['work']) {
  const stop = keepLease(
    () => update(ofRow(row), { sessionUntil: sessionLeaseEnd }),
    () => update(ofRow(row), { sessionUntil: null })
  );
  const ended = (err: unknown) => {
    log('warn', { msg: 'permission request ended', requestId: row.id, error: errorLabel(err) });
    return outcomeOf(err, row);
  };
  // Settled inside the session when the wallet answers, outside it when the session itself fails.
  void wallet
    .run(async (ask) => settle(row, await work(ask).catch(ended)))
    .catch((err: unknown) => settle(row, ended(err)))
    .catch((err: unknown) =>
      log('warn', { msg: 'permission request not settled', requestId: row.id, error: errorLabel(err) })
    )
    .finally(stop);
}
