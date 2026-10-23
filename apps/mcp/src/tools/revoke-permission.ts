import type { GrantedPermission } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, sql } from 'drizzle-orm';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS, SUPPORTED_CHAINS } from '@/connections/config';
import { ownerRelay, type OpenWallet } from '@/connections/relay';
import { getDb } from '@/db/client';
import { countHit } from '@/db/settings';
import { grants } from '@/db/schema';
import type { ReadPermission } from '@/grants/permission';
import {
  lostBefore,
  lostLinkSaid,
  openLink,
  RECONNECTING,
  reconnecting,
  revokeHeld,
  type PermissionRequestRow,
} from '@/grants/requests';
import { REVOKE_READS, revokeWork, sameId, type RevokeTarget } from '@/grants/resume';
import { fromStore, markRevoked, readState, type LookUp } from '@/grants/revokes';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { chainName, expiresIn, onDate, withinWindow } from '@/lib/owner-text';
import { LINK_RATE_LIMIT } from '@/owner-calls/cap';
import { listed, spendLimits } from './grant-permissions';
import { ACCOUNT_BUSY, refusal, withNext } from './reply';

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

export interface RevokeDeps {
  openWallet: OpenWallet;
  readPermission: ReadPermission;
  lookUp: LookUp;
  rereadMs: number;
}

const DEFAULTS: RevokeDeps = { openWallet: ownerRelay, lookUp: fromStore, ...REVOKE_READS };
type Target = RevokeTarget;

const unknown = (id: string) =>
  withNext(
    'unknown_permission: No permission with that id was granted from this wallet. Nothing was asked.',
    `No permission ${id} was granted from this account. jaw_connections lists the ones this server holds.`
  );

/** The network's name, or its id in words for a chain nobody knows, so the owner never reads a raw chain id. */
const networkOf = (chainId: number) => {
  const name = chainName(chainId);
  return name.startsWith('eip155:') ? `the network with id ${chainId}` : name;
};

async function findPermission(t: Tenant, id: Hex, chainId: number, lookUp: LookUp): Promise<Target | string> {
  const [row] = await getDb()
    .select()
    .from(grants)
    .where(and(sameId(id), sql`lower(${grants.account}) = ${t.account.toLowerCase()}`));
  if (row?.revokedAt) {
    return withNext(
      `already_revoked: This permission was already revoked, on ${onDate(row.revokedAt)}. Nothing was asked.`,
      `Permission ${id} was revoked at ${row.revokedAt.toISOString()}.`
    );
  }
  const stored = await lookUp(id);
  if (stored === 'unavailable') {
    return 'lookup_unavailable: The permission could not be looked up right now. Nothing was asked. Try again in a minute.';
  }
  if (stored === 'not_found' && row) {
    return withNext(
      'not_in_store: The wallet cannot revoke this permission from its screen. It stays approved until it expires, or until the app that holds it disconnects.',
      `The wallet revokes from JAW's permission store, which does not hold ${id}. jaw_session_disconnect from its connection revokes it.`
    );
  }
  const found = row ? { permission: row.permission as GrantedPermission, chainId: row.chainId } : stored;
  if (found === 'not_found' || !isAddressEqual(found.permission.account as Address, t.account)) return unknown(id);
  if (found.chainId !== chainId) {
    return withNext(
      `wrong_chain: This permission was granted on ${networkOf(found.chainId)}, not ${networkOf(chainId)}. Nothing was asked.`,
      `Permission ${id} was granted on chainId ${found.chainId}, not ${chainId}. Pass chainId ${found.chainId}.`
    );
  }
  return { permissionId: id, chainId, permission: found.permission, connectionId: row?.connectionId ?? null };
}

/** Who the permission lets act, as the owner reads it. */
const holder = (t: Tenant, target: Target) =>
  target.connectionId === t.connectionId
    ? 'this connection'
    : target.connectionId
      ? 'another app'
      : 'an app this service has no record of';

async function answer(t: Tenant, target: Target, row: PermissionRequestRow) {
  const lost = await lostBefore(row);
  const { spender, spends } = target.permission;
  const limits = spendLimits(target.chainId, spends);
  const moving = limits.length ? `, moving up to ${listed(limits)}` : '';
  const lostSaid = lost && lostLinkSaid(lost, 'revoke');
  const say = [
    `It asks the owner to revoke a permission that lets ${holder(t, target)} act from their wallet${moving}, ${withinWindow(row.approveBy)}. ` +
      'Revoking takes effect at once; the owner pays the network fee.',
    ...(lostSaid ? [lostSaid.say] : []),
  ].join('\n');
  const next =
    'Show the link now. Then check jaw_connections on later turns to see it revoked; do not wait for the owner to say they did. ' +
    `It lets ${spender} act for the account.` +
    (lost && lostSaid
      ? ` ${lostSaid.next} It asked to revoke ${lost.permissionId}. A revoke the owner already approved there still shows on chain, and asking for it again reads it as already_revoked.`
      : '');
  return reply({
    url: row.walletUrl,
    permissionId: target.permissionId,
    chainId: target.chainId,
    spender,
    connection: target.connectionId,
    approveBy: row.approveBy.toISOString(),
    summary: `Open this link to revoke: ${row.walletUrl}\n${withNext(say, next)}`,
  });
}

export async function revokePermission(t: Tenant, input: RevokeInput, deps = DEFAULTS) {
  const chainId = input.chainId ?? t.chainId;
  if (!SUPPORTED_CHAINS[chainId]) {
    return refusal(
      withNext(
        `unsupported_chain: Permissions on ${networkOf(chainId)} cannot be revoked from here. Nothing was asked.`,
        `chainId ${chainId} is not one this server reads. It reads ${Object.keys(SUPPORTED_CHAINS).join(', ')}.`
      )
    );
  }
  if (
    !(await revokeHeld(t, input.permissionId)) &&
    (await countHit(`owner-revoke:${t.connectionId}`, RATE_WINDOW_MS)) > LINK_RATE_LIMIT
  ) {
    return refusal('rate_limited: Too many revoke requests in a short time. Nothing was asked. Wait a minute.');
  }
  const target = await findPermission(t, input.permissionId as Hex, chainId, deps.lookUp);
  if (typeof target === 'string') return refusal(target);
  if (target.permission.end * 1000 <= Date.now()) {
    return refusal('expired: This permission already ended, so there is nothing to revoke.');
  }
  const state = await readState(target, deps.readPermission);
  if (state.status === 'unavailable') {
    return refusal(
      'chain_unreadable: The network could not be read for this permission. Nothing was asked. Try again in a minute.'
    );
  }
  if (state.status === 'mismatch') {
    return refusal(
      withNext(
        'permission_mismatch: This permission cannot be revoked from here: its record does not match what is on chain. Nothing was asked.',
        `The stored permission ${target.permissionId} does not hash to its id on chain.`
      )
    );
  }
  if (!state.approved) return refusal(unknown(target.permissionId));
  if (state.revoked) {
    await markRevoked(target.permissionId);
    return refusal('already_revoked: This permission is already revoked. Nothing was asked.');
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
  if ('opened' in opened) return answer(t, target, opened.opened);
  const held = opened.waiting;
  const until = held.approveBy.toISOString();
  const rejoining = reconnecting(held) ? RECONNECTING : '';
  if (held.connectionId !== t.connectionId) {
    return refusal(
      withNext(
        `revoke_in_progress: Another app already asked the owner to revoke this permission, and that request ${expiresIn(held.approveBy)}.`,
        `Another app on this account asked the owner to revoke ${held.permissionId}; that link waits until ${until}.${rejoining} Check jaw_connections on later turns to see it revoked.`
      )
    );
  }
  if (held.permissionId?.toLowerCase() !== target.permissionId.toLowerCase()) {
    return refusal(
      withNext(
        `revoke_in_progress: A request to revoke another permission is already waiting for the owner, and it ${expiresIn(held.approveBy)}.`,
        `This connection already asked the owner to revoke ${held.permissionId}. Ask again once they answer or the link ends at ${until}.${rejoining}`
      )
    );
  }
  return answer(t, target, held);
}

export function registerRevokeTool(server: McpServer) {
  server.registerTool(
    'jaw_revoke_permission',
    {
      title: 'Revoke a permission',
      description:
        'Ask the owner to revoke a permission in their JAW wallet: one this connection holds, one another app holds, or any other permission granted from this wallet. ' +
        'Once revoked, nothing can act under it; the owner pays the network fee. ' +
        "Use it when the owner wants to take back an app's or agent's access, or to clear a replaced spend limit that jaw_connections lists as still approved. " +
        'jaw_connections gives the permissionId. ' +
        'To end this connection and revoke all of its permissions at once, use jaw_session_disconnect instead. ' +
        'Returns a link: show it on its own line before anything else; asking again while it waits returns the same link. ' +
        'Then check jaw_connections on later turns to see it revoked; do not wait for the owner to say they did.',
      inputSchema: revokeInput,
      outputSchema: output,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input, ctx) => revokePermission(tenant(ctx), input)
  );
}
