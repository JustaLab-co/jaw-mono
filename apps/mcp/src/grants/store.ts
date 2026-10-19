import type { GrantedPermission } from '@jaw.id/agent';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
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

export const x402Budget = async (connectionId: string): Promise<Grant | undefined> =>
  (await x402Budgets(connectionId))[0];

export async function liveGrants(connectionId: string, db: Tx = getDb()): Promise<LiveGrant[]> {
  const rows = await db
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, connectionId), live))
    .orderBy(desc(grants.createdAt));
  return rows.map(toLive);
}
