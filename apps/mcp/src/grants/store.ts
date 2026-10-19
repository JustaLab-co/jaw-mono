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

const live = (connectionId: string) =>
  and(eq(grants.connectionId, connectionId), isNull(grants.revokedAt), gt(grants.expiresAt, sql`now()`));

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

/**
 * The x402 budgets of the connection that can still be spent from, newest first.
 * A budget replaced before a connection could hold several grants never is.
 */
export async function x402Budgets(connectionId: string): Promise<Grant[]> {
  const rows = await getDb()
    .select()
    .from(grants)
    .where(and(live(connectionId), eq(grants.kind, 'x402-budget'), isNull(grants.replacedAt)))
    .orderBy(desc(grants.createdAt));
  return rows.map(toGrant);
}

/** The budget payments, quotes, swaps and refills draw from: the newest one. */
export const x402Budget = async (connectionId: string): Promise<Grant | undefined> =>
  (await x402Budgets(connectionId))[0];

/** Every grant of the connection not yet revoked or expired, of any kind. */
export async function liveGrants(connectionId: string, db: Tx = getDb()): Promise<Grant[]> {
  const rows = await db.select().from(grants).where(live(connectionId)).orderBy(desc(grants.createdAt));
  return rows.map(toGrant);
}
