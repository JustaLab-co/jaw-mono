import {
  callRuleKey,
  parseGrantedPermission,
  readPermissionState,
  type PermissionReadTarget,
  type PermissionState,
} from '@jaw.id/agent';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { isAddressEqual, isHex, numberToHex, toFunctionSelector, type Address, type Hex } from 'viem';
import type { Tx } from '@/db/client';
import { connections, grants, SPEND_UNITS } from '@/db/schema';
import { publicClientFor } from '@/lib/chain';
import { grantsBeside, LIVE_GRANTS_PER_CONNECTION, type GrantKind } from './store';

const TRANSFER_SIGNATURE = 'transfer(address,uint256)';

export type SpendUnit = (typeof SPEND_UNITS)[number];

export interface PermissionCall {
  target: Address;
  functionSignature: string;
  /** Contract the permission manager asks to approve each call. Absent means none. */
  checker?: Address;
}

export interface PermissionSpend {
  token: Address;
  /** Base units of the token, as a decimal string. */
  allowance: string;
  unit: SpendUnit;
  multiplier: number;
}

export interface GrantRequest {
  spender: Address;
  expiry: number;
  chainId: Hex;
  permissions: { calls: PermissionCall[]; spends: PermissionSpend[] };
  capabilities?: { prefundSpender: true };
}

export function budgetGrant(b: {
  chainId: number;
  spender: Address;
  token: Address;
  allowance: bigint;
  expiry: number;
}): GrantRequest {
  return {
    spender: b.spender,
    expiry: b.expiry,
    chainId: numberToHex(b.chainId),
    permissions: {
      calls: [{ target: b.token, functionSignature: TRANSFER_SIGNATURE }],
      spends: [{ token: b.token, allowance: b.allowance.toString(), unit: 'day', multiplier: 1 }],
    },
    // The session pays its own first op's fee from what the wallet sends along.
    capabilities: { prefundSpender: true },
  };
}

type Granted = NonNullable<ReturnType<typeof parseGrantedPermission>>;

const spendKey = (s: Granted['spends'][number]) =>
  `${s.token.toLowerCase()}:${BigInt(s.allowance)}:${s.unit}:${s.multiplier}`;
const sameKeys = (asked: string[], got: string[]) => asked.sort().join() === got.sort().join();

/** Whether what the wallet granted is exactly what was asked. Start and salt are the wallet's. */
function grantMatches(grant: GrantRequest, permission: Granted): boolean {
  const { calls, spends } = grant.permissions;
  return (
    isAddressEqual(permission.spender as Address, grant.spender) &&
    permission.end === grant.expiry &&
    sameKeys(
      // The checker is part of the permission hash. A wallet from before checkers names none, and
      // one after names zero on every call that asked for none; `callRuleKey` reads both as zero.
      calls.map((c) => callRuleKey({ ...c, selector: toFunctionSelector(c.functionSignature) })),
      permission.calls.map(callRuleKey)
    ) &&
    sameKeys(spends.map(spendKey), permission.spends.map(spendKey))
  );
}

export type ReadPermission = (target: PermissionReadTarget) => Promise<PermissionState>;

export const readOnChain: ReadPermission = (target) =>
  readPermissionState(target, { clients: { publicClient: publicClientFor } });

export type NewGrant = Omit<typeof grants.$inferInsert, 'connectionId' | 'createdAt'> & { kind: GrantKind };

type GrantRefusal = 'invalid_response' | 'grant_mismatch' | 'grant_not_found' | 'verification_unavailable';

/**
 * What the wallet answered, checked against what was asked and against the chain,
 * which is what proves the account: only its owner can approve a permission for it.
 */
export async function checkGranted(
  chainId: number,
  grant: GrantRequest,
  kind: GrantKind,
  answer: unknown,
  read: ReadPermission
): Promise<NewGrant | GrantRefusal> {
  const permission = parseGrantedPermission(answer);
  const permissionId = (answer as { permissionId?: unknown } | null)?.permissionId;
  if (!permission || !isHex(permissionId)) return 'invalid_response';
  if (!grantMatches(grant, permission)) return 'grant_mismatch';
  const state = await read({ chainId, permissionId, permission }).catch(
    (): PermissionState => ({ status: 'unavailable' })
  );
  if (state.status === 'unavailable') return 'verification_unavailable';
  if (state.status === 'mismatch') return 'grant_mismatch';
  if (!state.approved || state.revoked) return 'grant_not_found';
  const { spends } = grant.permissions;
  const only = spends.length === 1 ? spends[0] : undefined;
  return {
    permissionId,
    kind,
    chainId,
    account: permission.account,
    spender: grant.spender,
    token: only?.token ?? null,
    allowance: only?.allowance ?? null,
    period: only?.unit ?? null,
    permission,
    expiresAt: new Date(permission.end * 1000),
  };
}

export async function recordGrant(tx: Tx, connectionId: string, grant: NewGrant) {
  await tx.select({ id: connections.id }).from(connections).where(eq(connections.id, connectionId)).for('update');
  const [recorded] = await tx
    .select({ id: grants.permissionId })
    .from(grants)
    .where(
      and(eq(grants.permissionId, grant.permissionId), eq(grants.connectionId, connectionId), isNull(grants.revokedAt))
    );
  if (recorded) return;
  if ((await grantsBeside(connectionId, grant.kind, tx)) >= LIVE_GRANTS_PER_CONNECTION) {
    throw new Error(`the connection already holds ${LIVE_GRANTS_PER_CONNECTION} live grants`);
  }
  const inserted = await tx
    .insert(grants)
    .values({ ...grant, connectionId, createdAt: sql`clock_timestamp()` })
    .onConflictDoNothing()
    .returning({ permissionId: grants.permissionId });
  if (inserted.length === 0)
    throw new Error('a grant with that id was already revoked or belongs to another connection');
  if (grant.kind !== 'x402-budget') return;
  // Payments draw from the newest budget only, so an older one is exposure with no use.
  await tx
    .update(grants)
    .set({ replacedAt: new Date() })
    .where(
      and(
        eq(grants.connectionId, connectionId),
        eq(grants.kind, 'x402-budget'),
        ne(grants.permissionId, grant.permissionId),
        isNull(grants.replacedAt),
        isNull(grants.revokedAt)
      )
    );
}
