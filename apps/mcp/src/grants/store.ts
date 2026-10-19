import type { GrantedPermission } from '@jaw.id/agent';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { getDb, type Tx } from '@/db/client';
import { grants } from '@/db/schema';

export type GrantKind = (typeof grants.$inferSelect)['kind'];

export interface Grant {
  permissionId: Hex;
  kind: GrantKind;
  chainId: number;
  account: Address;
  spender: Address;
  token: Address;
  allowance: string;
  permission: GrantedPermission;
  expiresAt: Date;
  createdAt: Date;
}

export const LIVE_GRANTS_PER_CONNECTION = 5;

const live = and(isNull(grants.revokedAt), gt(grants.expiresAt, sql`now()`));
export const spendableBudget = and(live, eq(grants.kind, 'x402-budget'), isNull(grants.replacedAt));

const toGrant = (row: typeof grants.$inferSelect): Grant => ({
  permissionId: row.permissionId as Hex,
  kind: row.kind,
  chainId: row.chainId,
  account: row.account as Address,
  spender: row.spender as Address,
  token: row.token as Address,
  allowance: row.allowance,
  permission: row.permission as GrantedPermission,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
});

export async function x402Budgets(connectionId: string): Promise<Grant[]> {
  const rows = await getDb()
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, connectionId), spendableBudget))
    .orderBy(desc(grants.createdAt));
  return rows.map(toGrant);
}

export const x402Budget = async (connectionId: string): Promise<Grant | undefined> =>
  (await x402Budgets(connectionId))[0];

export async function liveGrants(connectionId: string, db: Tx = getDb()): Promise<Grant[]> {
  const rows = await db
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, connectionId), live))
    .orderBy(desc(grants.createdAt));
  return rows.map(toGrant);
}
