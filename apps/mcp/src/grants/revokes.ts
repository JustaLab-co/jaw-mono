import { getPermissionFromRelay } from '@jaw.id/core';
import { parseGrantedPermission, type GrantedPermission, type PermissionState } from '@jaw.id/agent';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Hex } from 'viem';
import { config } from '@/connections/config';
import { getDb } from '@/db/client';
import { grants, permissionRequests } from '@/db/schema';
import { errorLabel, log } from '@/lib/edge';
import type { ReadPermission } from './permission';

export const UNCONFIRMED = 'unconfirmed';
const NOT_SEEN = 'revoke_not_seen';
const READ_FOR = sql`interval '1 day'`;
const READ_EVERY = sql`interval '5 minutes'`;
const UNCONFIRMED_BATCH = 50;

export type StoredPermission = { permission: GrantedPermission; chainId: number } | 'not_found' | 'unavailable';
export type LookUp = (permissionId: Hex) => Promise<StoredPermission>;
export interface RevokeReads {
  readPermission: ReadPermission;
  lookUp: LookUp;
  lookUpMs: number;
}

export const fromStore: LookUp = async (permissionId) => {
  try {
    const stored = await getPermissionFromRelay(permissionId, config().paymasterApiKey);
    const permission = parseGrantedPermission(stored);
    const chainId = Number.parseInt(stored.chainId, 16);
    return permission && Number.isSafeInteger(chainId) ? { permission, chainId } : 'not_found';
  } catch (err) {
    const status =
      (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return 'not_found';
    const message = err instanceof Error ? err.message : '';
    const missing = /not\s*found|does not exist|no such permission/i.test(message);
    return status === undefined && missing ? 'not_found' : 'unavailable';
  }
};

export const readState = (target: Parameters<ReadPermission>[0], read: ReadPermission) =>
  read(target).catch((): PermissionState => ({ status: 'unavailable' }));

const revokeOf = (id: string) =>
  and(eq(permissionRequests.method, 'revoke'), sql`lower(${permissionRequests.permissionId}) = ${id.toLowerCase()}`);
const unconfirmed = and(eq(permissionRequests.state, 'approved'), eq(permissionRequests.code, UNCONFIRMED));
const notSeen = and(eq(permissionRequests.state, 'failed'), eq(permissionRequests.code, NOT_SEEN));

/** Marks the grant revoked and settles its revoke requests the chain had not shown. Returns how many it settled. */
export const markRevoked = (id: string) =>
  getDb().transaction(async (tx) => {
    await tx
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(and(sql`lower(${grants.permissionId}) = ${id.toLowerCase()}`, isNull(grants.revokedAt)));
    const settled = await tx
      .update(permissionRequests)
      .set({ state: 'approved', code: null, updatedAt: sql`statement_timestamp()` })
      .where(and(revokeOf(id), or(unconfirmed, notSeen)))
      .returning({ id: permissionRequests.id });
    return settled.length;
  });

const lookUpWithin = ({ lookUp, lookUpMs }: RevokeReads, id: Hex): Promise<StoredPermission> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'unavailable'>((resolve) => (timer = setTimeout(() => resolve('unavailable'), lookUpMs)));
  return Promise.race([lookUp(id), late]).finally(() => clearTimeout(timer));
};

async function revokedOnChain(
  request: typeof permissionRequests.$inferSelect,
  grant: typeof grants.$inferSelect | null,
  deps: RevokeReads
): Promise<boolean> {
  if (grant?.revokedAt) return true;
  const permissionId = request.permissionId as Hex;
  const stored = grant ? { permission: grant.permission as GrantedPermission } : await lookUpWithin(deps, permissionId);
  if (typeof stored === 'string') return false;
  const state = await readState(
    { permissionId, chainId: request.chainId, permission: stored.permission },
    deps.readPermission
  );
  return state.status === 'ok' && state.revoked;
}

/**
 * Revokes the wallet approved but the chain did not show in time. Each is read again at most every
 * five minutes for a day, claimed so concurrent runs split them, then ends `failed` as revoke_not_seen.
 * The grant row of the same account gives the permission, else the permission store.
 */
export async function settleUnconfirmedRevokes(deps: RevokeReads): Promise<number> {
  const db = getDb();
  const given = await db
    .update(permissionRequests)
    .set({ state: 'failed', code: NOT_SEEN, updatedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(permissionRequests.method, 'revoke'),
        unconfirmed,
        lte(permissionRequests.createdAt, sql`now() - ${READ_FOR}`)
      )
    )
    .returning({ id: permissionRequests.id });
  if (given.length) log('warn', { msg: `${given.length} approved revokes never showed on chain` });
  const due = db
    .select({ id: permissionRequests.id })
    .from(permissionRequests)
    .where(
      and(
        eq(permissionRequests.method, 'revoke'),
        unconfirmed,
        lte(permissionRequests.updatedAt, sql`now() - ${READ_EVERY}`)
      )
    )
    .orderBy(sql`random()`)
    .limit(UNCONFIRMED_BATCH)
    .for('update', { skipLocked: true });
  const claimed = await db
    .update(permissionRequests)
    .set({ updatedAt: sql`statement_timestamp()` })
    .where(inArray(permissionRequests.id, due))
    .returning();
  if (!claimed.length) return 0;
  const byPermission = new Map(claimed.map((r) => [(r.permissionId as string).toLowerCase(), r]));
  const held = await db
    .select()
    .from(grants)
    .where(inArray(sql`lower(${grants.permissionId})`, [...byPermission.keys()]));
  const grantOf = (r: typeof permissionRequests.$inferSelect) =>
    held.find(
      (g) =>
        g.permissionId.toLowerCase() === r.permissionId?.toLowerCase() &&
        g.account.toLowerCase() === r.account.toLowerCase()
    ) ?? null;
  const settled = await Promise.all(
    [...byPermission.values()].map(async (request) => {
      try {
        return (await revokedOnChain(request, grantOf(request), deps))
          ? await markRevoked(request.permissionId as string)
          : 0;
      } catch (err) {
        log('warn', { msg: `revoke request ${request.id} not settled`, error: errorLabel(err) });
        return 0;
      }
    })
  );
  return settled.reduce((a, b) => a + b, 0);
}
