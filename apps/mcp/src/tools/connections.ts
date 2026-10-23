import type { GrantedPermission } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, desc, eq, inArray, isNotNull, isNull, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { ownedBy } from '@/connections/rows';
import { getDb } from '@/db/client';
import { connections, grants, permissionRequests, SPEND_UNITS } from '@/db/schema';
import { reply } from '@/lib/fence';
import { withNext } from './reply';

const grantView = z.object({
  permissionId: z.string(),
  kind: z.enum(['x402-budget', 'custom']),
  status: z
    .enum(['live', 'replaced', 'expired', 'revoked'])
    .describe(
      'replaced: a newer spend limit for paid services took its place, so no new payment draws from it, but the server has not revoked it and it stays approved on chain; jaw_revoke_permission revokes it'
    ),
  spends: z.array(
    z.object({
      token: z.string(),
      allowance: z.string().describe('Base units of the token the session key may move per period'),
      unit: z.string().describe(`One of ${SPEND_UNITS.join(', ')}`),
      multiplier: z.number().describe('Periods per limit'),
    })
  ),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});

const connectionView = z.object({
  id: z.string(),
  current: z.boolean().describe('The connection this call came from'),
  client: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(['active', 'expired', 'revoked']),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  payer: z
    .string()
    .nullable()
    .describe("The connection's session address, which holds the USDC it pays fees and paid services with"),
  grants: z.array(grantView).describe('Newest first. jaw_revoke_permission takes a permissionId from here'),
  unrecorded: z
    .array(z.string())
    .describe(
      'permissionIds the wallet answered for this connection that this server did not record, which may be live on chain; jaw_revoke_permission revokes them'
    ),
});

type View = z.infer<typeof connectionView>;
type GrantRow = typeof grants.$inferSelect;

function statusOf(g: GrantRow, now: Date): z.infer<typeof grantView>['status'] {
  if (g.revokedAt) return 'revoked';
  if (g.expiresAt <= now) return 'expired';
  return g.replacedAt ? 'replaced' : 'live';
}

function grantOf(g: GrantRow, now: Date): z.infer<typeof grantView> {
  const { spends } = g.permission as GrantedPermission;
  return {
    permissionId: g.permissionId,
    kind: g.kind,
    status: statusOf(g, now),
    spends: spends.map((s) => ({ ...s, allowance: BigInt(s.allowance).toString() })),
    expiresAt: g.expiresAt.toISOString(),
    revokedAt: g.revokedAt?.toISOString() ?? null,
  };
}

const revokes = alias(permissionRequests, 'revokes');

/** "1 app", "2 apps". */
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

async function viewsOf(t: Tenant, rows: (typeof connections.$inferSelect)[]): Promise<View[]> {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const answered = and(
    inArray(permissionRequests.connectionId, ids),
    eq(permissionRequests.method, 'grant'),
    isNotNull(permissionRequests.permissionId),
    sql`${permissionRequests.code} is distinct from 'wrong_account'`,
    notExists(getDb().select().from(grants).where(eq(grants.permissionId, permissionRequests.permissionId))),
    notExists(
      getDb()
        .select()
        .from(revokes)
        .where(
          and(
            eq(revokes.method, 'revoke'),
            sql`lower(${revokes.permissionId}) = lower(${permissionRequests.permissionId})`,
            eq(revokes.state, 'approved'),
            isNull(revokes.code)
          )
        )
    )
  );
  const [held, orphans] = await Promise.all([
    getDb().select().from(grants).where(inArray(grants.connectionId, ids)).orderBy(desc(grants.createdAt)),
    getDb().select().from(permissionRequests).where(answered).orderBy(desc(permissionRequests.createdAt)),
  ]);
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    current: row.id === t.connectionId,
    client: row.clientName,
    scopes: row.scopes,
    status: row.status === 'active' && row.expiresAt <= now ? 'expired' : (row.status as View['status']),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    payer: row.sessionAddress,
    grants: held.filter((g) => g.connectionId === row.id).map((g) => grantOf(g, now)),
    unrecorded: orphans.filter((r) => r.connectionId === row.id).map((r) => r.permissionId!),
  }));
}

export function registerConnectionTools(server: McpServer) {
  server.registerTool(
    'jaw_connections',
    {
      title: 'Apps connected to the wallet',
      description:
        'Every app connected to this wallet through this service, this one included, with the permissions each holds: kind, spend limits, expiry, and whether each is live, replaced, expired or revoked. ' +
        'Use it when the owner asks what has access to their wallet, before revoking (it gives the permissionId), and to find the custom permission a run should use. ' +
        'For what is left of the spend limit for paid services today, use jaw_session_status.',
      inputSchema: z.strictObject({}),
      outputSchema: z.object({ connections: z.array(connectionView), summary: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (_input, ctx) => {
      const t = tenant(ctx);
      const rows = await getDb()
        .select()
        .from(connections)
        .where(and(ownedBy(t.account), eq(connections.chainId, t.chainId), ne(connections.status, 'pending')))
        .orderBy(desc(connections.createdAt));
      const views = await viewsOf(t, rows);
      const active = views.filter((v) => v.status === 'active').length;
      const ended = views.length - active;
      const held = views.flatMap((v) => v.grants);
      const live = held.filter((g) => g.status === 'live').length;
      const replaced = held.filter((g) => g.status === 'replaced').map((g) => g.permissionId);
      const said = [
        `${counted(active, 'app')} connected, ${counted(live, 'permission')} in force.`,
        ended > 0 && `${counted(ended, 'earlier connection')} ${ended === 1 ? 'has' : 'have'} ended.`,
        replaced.length > 0 &&
          (replaced.length === 1
            ? '1 replaced spend limit is still approved on chain until it expires.'
            : `${replaced.length} replaced spend limits are still approved on chain until they expire.`),
      ];
      return reply({
        connections: views,
        summary: withNext(
          said.filter(Boolean).join(' '),
          `jaw_revoke_permission takes a permissionId from here${replaced.length ? `; the replaced ones are ${replaced.join(', ')}` : ''}.`
        ),
      });
    }
  );
}
