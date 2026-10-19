import {
  parseGrantedPermission,
  readPermissionState,
  type PermissionReadTarget,
  type PermissionState,
} from '@jaw.id/agent';
import { sql } from 'drizzle-orm';
import { isAddressEqual, isHex, numberToHex, toFunctionSelector, type Address, type Hex } from 'viem';
import type { Tx } from '@/db/client';
import { grants } from '@/db/schema';
import { publicClientFor } from '@/lib/chain';
import type { GrantKind } from './store';

const TRANSFER_SIGNATURE = 'transfer(address,uint256)';

export interface PermissionCall {
  target: Address;
  functionSignature: string;
}

/** `wallet_grantPermissions` as the wallet takes it: a daily USDC allowance, and the calls it may pay for. */
export interface GrantRequest {
  spender: Address;
  expiry: number;
  chainId: Hex;
  permissions: {
    calls: PermissionCall[];
    spends: { token: Address; allowance: string; unit: 'day'; multiplier: 1 }[];
  };
  capabilities: { prefundSpender: true };
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
      // Refills and payments go through the USDC transfer.
      calls: [{ target: b.token, functionSignature: TRANSFER_SIGNATURE }],
      spends: [{ token: b.token, allowance: b.allowance.toString(), unit: 'day', multiplier: 1 }],
    },
    // The session pays its own first op's fee from what the wallet sends along.
    capabilities: { prefundSpender: true },
  };
}

type Granted = NonNullable<ReturnType<typeof parseGrantedPermission>>;

/** Whether what the wallet granted is exactly what was asked. Start and salt are the wallet's. */
function grantMatches(grant: GrantRequest, permission: Granted): boolean {
  // Calls compare as sorted target:selector pairs, so the wallet's order does not matter.
  const asked = grant.permissions.calls
    .map((c) => `${c.target.toLowerCase()}:${toFunctionSelector(c.functionSignature)}`)
    .sort();
  const got = permission.calls.map((c) => `${c.target.toLowerCase()}:${c.selector.toLowerCase()}`).sort();
  const [spend] = grant.permissions.spends;
  const [granted] = permission.spends;
  return (
    isAddressEqual(permission.spender as Address, grant.spender) &&
    permission.end === grant.expiry &&
    asked.length === got.length &&
    asked.every((c, i) => c === got[i]) &&
    permission.spends.length === 1 &&
    isAddressEqual(granted.token as Address, spend.token) &&
    BigInt(granted.allowance) === BigInt(spend.allowance) &&
    granted.unit === spend.unit &&
    granted.multiplier === spend.multiplier
  );
}

export type ReadPermission = (target: PermissionReadTarget) => Promise<PermissionState>;

export const readOnChain: ReadPermission = (target) =>
  readPermissionState(target, { clients: { publicClient: publicClientFor } });

// The column's default is for a build from before it, still running mid-deploy; this one names the kind.
export type NewGrant = Omit<typeof grants.$inferInsert, 'connectionId' | 'createdAt'> & { kind: GrantKind };

type GrantRefusal = 'invalid_response' | 'grant_mismatch' | 'grant_not_found' | 'verification_unavailable';

/**
 * What the wallet answered, checked against what was asked and against the chain,
 * which is what proves the account: only its owner can approve a permission for it.
 */
export async function checkGranted(
  chainId: number,
  grant: GrantRequest,
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
  const [spend] = grant.permissions.spends;
  return {
    permissionId,
    // The only request grantMatches accepts today is the daily USDC budget.
    kind: 'x402-budget',
    chainId,
    account: permission.account,
    spender: grant.spender,
    token: spend.token,
    allowance: spend.allowance,
    period: spend.unit,
    permission,
    expiresAt: new Date(permission.end * 1000),
  };
}

/** Stores a grant beside the connection's others; a second approval of the same permission is a no-op. */
export async function recordGrant(tx: Tx, connectionId: string, grant: NewGrant) {
  await tx
    .insert(grants)
    .values({ ...grant, connectionId, createdAt: sql`clock_timestamp()` })
    .onConflictDoNothing();
}
