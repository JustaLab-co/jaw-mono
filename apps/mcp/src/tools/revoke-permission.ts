import { getPermissionFromRelay } from '@jaw.id/core';
import { parseGrantedPermission, type GrantedPermission } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, sql } from 'drizzle-orm';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS, config, SUPPORTED_CHAINS } from '@/connections/config';
import { ownerRelay, type OpenWallet } from '@/connections/relay';
import { getDb } from '@/db/client';
import { grants } from '@/db/schema';
import type { ReadPermission } from '@/grants/permission';
import { lostBefore, lostPreamble, openLink, resumeRequest, type PermissionRequestRow } from '@/grants/requests';
import { markRevoked, readState, REVOKE_READS, revokeWork, sameId, type RevokeTarget } from '@/grants/resume';
import { reply } from '@/lib/fence';
import { ACCOUNT_BUSY, refusal } from './reply';

const revokeInput = z.strictObject({
  permissionId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('The permission to revoke: one jaw_connections lists, or any other granted from this account'),
  chainId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The chain it was granted on; defaults to this connection's chain"),
});
export type RevokeInput = z.infer<typeof revokeInput>;

const output = z.object({
  url: z.url(),
  permissionId: z.string(),
  chainId: z.number(),
  spender: z.string(),
  connection: z.string().nullable().describe('The connection that holds it; null when this server has no record of it'),
  approveBy: z.string(),
  summary: z.string(),
});

export type StoredPermission = { permission: GrantedPermission; chainId: number } | 'not_found' | 'unavailable';
export type LookUp = (permissionId: Hex) => Promise<StoredPermission>;

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

export interface RevokeDeps {
  openWallet: OpenWallet;
  readPermission: ReadPermission;
  lookUp: LookUp;
  rereadMs: number;
}

const DEFAULTS: RevokeDeps = { openWallet: ownerRelay, lookUp: fromStore, ...REVOKE_READS };
type Target = RevokeTarget;

const unknown = (id: string) =>
  `unknown_permission: no permission ${id} was granted from this account. jaw_connections lists the ones this server holds.`;

async function findPermission(t: Tenant, id: Hex, chainId: number, lookUp: LookUp): Promise<Target | string> {
  const [row] = await getDb()
    .select()
    .from(grants)
    .where(and(sameId(id), sql`lower(${grants.account}) = ${t.account.toLowerCase()}`));
  if (row?.revokedAt) return `already_revoked: permission ${id} was revoked at ${row.revokedAt.toISOString()}.`;
  const stored = await lookUp(id);
  if (stored === 'unavailable') {
    return 'lookup_unavailable: the permission store could not be read right now. Try again in a minute.';
  }
  if (stored === 'not_found' && row) {
    return `not_in_store: the wallet revokes from JAW's permission store, which does not hold ${id}. It stays approved until it expires, or until jaw_session_disconnect from its connection revokes it.`;
  }
  const found = row ? { permission: row.permission as GrantedPermission, chainId: row.chainId } : stored;
  if (found === 'not_found' || !isAddressEqual(found.permission.account as Address, t.account)) return unknown(id);
  if (found.chainId !== chainId) {
    return `wrong_chain: permission ${id} was granted on chain ${found.chainId}, not ${chainId}. Pass chainId ${found.chainId}.`;
  }
  return { permissionId: id, chainId, permission: found.permission, connectionId: row?.connectionId ?? null };
}

async function answer(target: Target, row: PermissionRequestRow) {
  const lost = await lostBefore(row);
  const { spender, spends } = target.permission;
  const tokens = spends.length ? ` and its limits on ${spends.map((s) => s.token).join(', ')}` : '';
  return reply({
    url: row.walletUrl,
    permissionId: target.permissionId,
    chainId: target.chainId,
    spender,
    connection: target.connectionId,
    approveBy: row.approveBy.toISOString(),
    summary:
      (lost
        ? lostPreamble(lost, 'revoke') +
          `It asked to revoke ${lost.permissionId}. A revoke the owner already approved there still shows on chain, and asking for it again reads it as already_revoked. `
        : '') +
      `Ask the account owner to open ${row.walletUrl} before ${row.approveBy.toISOString()} and revoke permission ${target.permissionId}, ` +
      `which lets ${spender} act for the account${tokens}. The owner pays the gas in the wallet. ` +
      'Once the chain shows it revoked, jaw_connections lists it revoked and nothing can spend under it.',
  });
}

export async function revokePermission(t: Tenant, input: RevokeInput, deps = DEFAULTS) {
  const chainId = input.chainId ?? t.chainId;
  if (!SUPPORTED_CHAINS[chainId]) return refusal(`unsupported_chain: chain ${chainId} is not one this server reads.`);
  const target = await findPermission(t, input.permissionId as Hex, chainId, deps.lookUp);
  if (typeof target === 'string') return refusal(target);
  if (target.permission.end * 1000 <= Date.now()) {
    return refusal(`expired: permission ${target.permissionId} already ended, so there is nothing to revoke.`);
  }
  const state = await readState(target, deps.readPermission);
  if (state.status === 'unavailable') {
    return refusal('chain_unreadable: the chain could not be read for this permission. Try again in a minute.');
  }
  if (state.status === 'mismatch') {
    return refusal(
      `permission_mismatch: the stored permission ${target.permissionId} does not hash to its id on chain, so it cannot be revoked from here.`
    );
  }
  if (!state.approved) return refusal(unknown(target.permissionId));
  if (state.revoked) {
    await markRevoked(target.permissionId);
    return refusal(`already_revoked: permission ${target.permissionId} is already revoked on chain.`);
  }
  const opened = await openLink(
    t,
    {
      method: 'revoke',
      chainId,
      approveBy: new Date(Date.now() + APPROVE_WITHIN_MS),
      permissionId: target.permissionId,
      payload: target,
      rebuild: revokeWork(deps),
    },
    deps.openWallet
  );
  if (opened === 'wallet_busy') return refusal('Too many owners are approving right now. Try again in a minute.');
  if (opened === 'account_busy') return refusal(ACCOUNT_BUSY);
  if ('opened' in opened) return answer(target, opened.opened);
  if (opened.waiting.relay) void resumeRequest(opened.waiting, revokeWork(deps));
  const held = opened.waiting;
  const until = held.approveBy.toISOString();
  if (held.connectionId !== t.connectionId) {
    return refusal(
      `revoke_in_progress: another app on this account asked the owner to revoke ${held.permissionId}; that link waits until ${until}.`
    );
  }
  if (held.permissionId?.toLowerCase() !== target.permissionId.toLowerCase()) {
    return refusal(
      `revoke_in_progress: this connection already asked the owner to revoke ${held.permissionId}. Ask again once they answer or the link ends at ${until}.`
    );
  }
  return answer(target, held);
}

export function registerRevokeTool(server: McpServer) {
  server.registerTool(
    'jaw_revoke_permission',
    {
      description:
        'Ask the account owner to revoke a permission on chain, confirmed in their JAW wallet: a grant of this connection, of another app connected to this account, or any other permission the account granted. ' +
        'Once revoked, nothing can spend or call under it. The owner pays the gas. Returns a link for the owner; asking again while it waits returns the same link. ' +
        "jaw_connections lists this server's grants by permissionId. To end this connection and revoke all of its grants at once, use jaw_session_disconnect.",
      inputSchema: revokeInput,
      outputSchema: output,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input, ctx) => revokePermission(tenant(ctx), input)
  );
}
