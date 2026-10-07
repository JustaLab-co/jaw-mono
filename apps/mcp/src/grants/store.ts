import type { GrantedPermission, PermissionReadTarget, PermissionState } from '@jaw.id/agent';
import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { getDb } from '@/db/client';
import { grants } from '@/db/schema';

export interface Grant {
  permissionId: Hex;
  chainId: number;
  account: Address;
  spender: Address;
  token: Address;
  allowance: string;
  permission: GrantedPermission;
  expiresAt: Date;
  createdAt: Date;
}

export async function currentGrant(connectionId: string): Promise<Grant | undefined> {
  const [row] = await getDb()
    .select()
    .from(grants)
    .where(and(eq(grants.connectionId, connectionId), gt(grants.expiresAt, sql`now()`)))
    .orderBy(desc(grants.createdAt))
    .limit(1);
  if (!row) return undefined;
  return {
    permissionId: row.permissionId as Hex,
    chainId: row.chainId,
    account: row.account as Address,
    spender: row.spender as Address,
    token: row.token as Address,
    allowance: row.allowance,
    permission: row.permission as GrantedPermission,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Replaced budgets that have not expired and the chain does not show revoked yet,
 * so the page can revoke them or retry. One the chain shows revoked is recorded
 * and drops out; one it cannot read stays listed.
 */
export async function outstandingRevokes(
  connectionId: string,
  read: (target: PermissionReadTarget) => Promise<PermissionState>
): Promise<Hex[]> {
  const rows = await getDb()
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.connectionId, connectionId),
        isNotNull(grants.replacedAt),
        isNull(grants.revokedAt),
        gt(grants.expiresAt, sql`now()`)
      )
    )
    .orderBy(grants.createdAt);
  const outstanding: Hex[] = [];
  for (const row of rows) {
    const target = {
      chainId: row.chainId,
      permissionId: row.permissionId,
      permission: row.permission as GrantedPermission,
    };
    const state = await read(target).catch((): PermissionState => ({ status: 'unavailable' }));
    if (state.status === 'ok' && state.revoked) {
      await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, row.permissionId));
    } else {
      outstanding.push(row.permissionId as Hex);
    }
  }
  return outstanding;
}
