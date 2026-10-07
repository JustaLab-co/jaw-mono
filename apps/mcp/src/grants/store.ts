import type { GrantedPermission } from '@jaw.id/agent';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { getDb } from '@/db/client';
import { grants } from '@/db/schema';

export interface Grant {
  permissionId: Hex;
  chainId: number;
  account: Address;
  spender: Address;
  token: Address;
  /** Base units per day. */
  allowance: string;
  permission: GrantedPermission;
  expiresAt: Date;
  createdAt: Date;
}

/** The connection's budget: its newest grant that has not ended. */
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
