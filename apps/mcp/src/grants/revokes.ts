import { getPermissionFromRelay } from '@jaw.id/core';
import { parseGrantedPermission, type GrantedPermission, type PermissionState } from '@jaw.id/agent';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Hex } from 'viem';
import { config } from '@/connections/config';
import { getDb } from '@/db/client';
import { grants, permissionRequests } from '@/db/schema';
import { errorLabel, log } from '@/lib/edge';
import type { ReadPermission } from './permission';

export const UNCONFIRMED = 'unconfirmed';
const UNCONFIRMED_READ_WINDOW = sql`interval '1 day'`;
const UNCONFIRMED_BATCH = 50;
const LOOK_UP_MS = 10_000;

export type StoredPermission = { permission: GrantedPermission; chainId: number } | 'not_found' | 'unavailable';
export type LookUp = (permissionId: Hex) => Promise<StoredPermission>;
export interface RevokeReads {
  readPermission: ReadPermission;
  lookUp: LookUp;
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

/** Marks the grant revoked and settles its unconfirmed revoke requests. Returns how many requests it settled. */
export const markRevoked = (id: string) =>
  getDb().transaction(async (tx) => {
    await tx
      .update(grants)
      .set({ revokedAt: new Date() })
      .where(and(sql`lower(${grants.permissionId}) = ${id.toLowerCase()}`, isNull(grants.revokedAt)));
    const settled = await tx
      .update(permissionRequests)
      .set({ code: null, updatedAt: sql`statement_timestamp()` })
      .where(
        and(
          eq(permissionRequests.method, 'revoke'),
          sql`lower(${permissionRequests.permissionId}) = ${id.toLowerCase()}`,
          eq(permissionRequests.state, 'approved'),
          eq(permissionRequests.code, UNCONFIRMED)
        )
      )
      .returning({ id: permissionRequests.id });
    return settled.length;
  });

const lookUpWithin = (lookUp: LookUp, id: Hex): Promise<StoredPermission> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'unavailable'>((resolve) => (timer = setTimeout(() => resolve('unavailable'), LOOK_UP_MS)));
  return Promise.race([lookUp(id), late]).finally(() => clearTimeout(timer));
};

async function revokedOnChain(
  request: typeof permissionRequests.$inferSelect,
  grant: typeof grants.$inferSelect | null,
  deps: RevokeReads
): Promise<boolean> {
  if (grant?.revokedAt) return true;
  const permissionId = request.permissionId as Hex;
  const stored = grant
    ? { permission: grant.permission as GrantedPermission }
    : await lookUpWithin(deps.lookUp, permissionId);
  if (typeof stored === 'string') return false;
  const state = await readState(
    { permissionId, chainId: request.chainId, permission: stored.permission },
    deps.readPermission
  );
  return state.status === 'ok' && state.revoked;
}

/**
 * Revokes the wallet approved but the chain did not show in time, read again for a day.
 * The grant row of the same account gives the permission, else the permission store.
 */
export async function settleUnconfirmedRevokes(deps: RevokeReads): Promise<number> {
  const rows = await getDb()
    .select({ request: permissionRequests, grant: grants })
    .from(permissionRequests)
    .leftJoin(
      grants,
      and(
        sql`lower(${grants.permissionId}) = lower(${permissionRequests.permissionId})`,
        sql`lower(${grants.account}) = lower(${permissionRequests.account})`
      )
    )
    .where(
      and(
        eq(permissionRequests.method, 'revoke'),
        eq(permissionRequests.state, 'approved'),
        eq(permissionRequests.code, UNCONFIRMED),
        gt(permissionRequests.updatedAt, sql`now() - ${UNCONFIRMED_READ_WINDOW}`)
      )
    )
    .orderBy(sql`random()`)
    .limit(UNCONFIRMED_BATCH);
  const settled = await Promise.all(
    rows.map(async ({ request, grant }) => {
      try {
        return (await revokedOnChain(request, grant, deps)) ? await markRevoked(request.permissionId as string) : 0;
      } catch (err) {
        log('warn', { msg: `revoke request ${request.id} not settled`, error: errorLabel(err) });
        return 0;
      }
    })
  );
  return settled.reduce((a, b) => a + b, 0);
}
