import type { GrantedPermission } from '@jaw.id/agent';
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { getDb, type Tx } from '@/db/client';
import { grants } from '@/db/schema';

export type GrantKind = (typeof grants.$inferSelect)['kind'];

export interface LiveGrant {
  permissionId: Hex;
  kind: GrantKind;
  chainId: number;
  account: Address;
  spender: Address;
  permission: GrantedPermission;
  expiresAt: Date;
  createdAt: Date;
}

export interface Grant extends LiveGrant {
  token: Address;
  allowance: string;
}

export const LIVE_GRANTS_PER_CONNECTION = 5;

const live = and(isNull(grants.revokedAt), gt(grants.expiresAt, sql`now()`));
export const spendableBudget = and(live, eq(grants.kind, 'x402-budget'), isNull(grants.replacedAt));

const toLive = (row: typeof grants.$inferSelect): LiveGrant => ({
  permissionId: row.permissionId as Hex,
  kind: row.kind,
  chainId: row.chainId,
  account: row.account as Address,
  spender: row.spender as Address,
  permission: row.permission as GrantedPermission,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
});

const toBudget = (row: typeof grants.$inferSelect): Grant => ({
  ...toLive(row),
  token: row.token as Address,
  allowance: row.allowance as string,
});

export async function x402Budgets(connectionId: string): Promise<Grant[]> {
  const rows = await getDb()
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, connectionId), spendableBudget))
    .orderBy(desc(grants.createdAt));
  return rows.map(toBudget);
}

/**
 * The budget a signed payment was charged to, while it has not ended, whether or not
 * it was revoked or replaced since. A proof signed under a replaced budget spends the
 * payer's float, not the budget, so it may go out again.
 */
export async function budgetSignedUnder(
  connectionId: string,
  permissionId: string | null
): Promise<(Grant & { revokedAt: Date | null; replaced: boolean }) | undefined> {
  if (!permissionId) return undefined;
  const [row] = await getDb()
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.connectionId, connectionId),
        eq(grants.permissionId, permissionId),
        eq(grants.kind, 'x402-budget'),
        gt(grants.expiresAt, sql`now()`)
      )
    );
  return row && { ...toBudget(row), revokedAt: row.revokedAt, replaced: row.replacedAt !== null };
}

export const x402Budget = async (connectionId: string): Promise<Grant | undefined> =>
  (await x402Budgets(connectionId))[0];

export async function unrevokedGrant(connectionId: string, permissionId: string): Promise<LiveGrant | undefined> {
  const [row] = await getDb()
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.connectionId, connectionId),
        sql`lower(${grants.permissionId}) = ${permissionId.toLowerCase()}`,
        isNull(grants.revokedAt)
      )
    );
  return row && toLive(row);
}

export async function liveGrants(connectionId: string, db: Tx = getDb()): Promise<LiveGrant[]> {
  const rows = await db
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, connectionId), live))
    .orderBy(desc(grants.createdAt));
  return rows.map(toLive);
}

/** Live grants that count toward the cap beside a new one of `kind`: a new budget replaces the current one. */
export async function grantsBeside(connectionId: string, kind: GrantKind, db: Tx = getDb()): Promise<number> {
  const replacedByIt =
    kind === 'x402-budget' ? or(ne(grants.kind, 'x402-budget'), isNotNull(grants.replacedAt)) : undefined;
  const rows = await db
    .select({ id: grants.permissionId })
    .from(grants)
    .where(and(eq(grants.connectionId, connectionId), live, replacedByIt));
  return rows.length;
}

/** Budgets a newer one replaced that are still approved, as far as this server knows. */
export async function replacedBudgets(connectionId: string, db: Tx = getDb()): Promise<LiveGrant[]> {
  const rows = await db
    .select()
    .from(grants)
    .where(
      and(eq(grants.connectionId, connectionId), live, eq(grants.kind, 'x402-budget'), isNotNull(grants.replacedAt))
    );
  return rows.map(toLive);
}

export async function sampleLiveGrants(limit: number): Promise<LiveGrant[]> {
  const rows = await getDb()
    .select()
    .from(grants)
    .where(live)
    .orderBy(sql`random()`)
    .limit(limit);
  return rows.map(toLive);
}

/** How many of them were not recorded revoked before. */
export async function recordRevoked(permissionIds: string[], db: Tx = getDb()): Promise<number> {
  if (permissionIds.length === 0) return 0;
  const rows = await db
    .update(grants)
    .set({ revokedAt: new Date() })
    .where(and(inArray(grants.permissionId, permissionIds), isNull(grants.revokedAt)))
    .returning({ permissionId: grants.permissionId });
  return rows.length;
}
