import type { GrantedPermission } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { ownedBy } from '@/connections/rows';
import { getDb } from '@/db/client';
import { connections, grants, SPEND_UNITS } from '@/db/schema';
import { reply } from '@/lib/fence';

const grantView = z.object({
  permissionId: z.string(),
  kind: z.enum(['x402-budget', 'custom']),
  status: z.enum(['live', 'expired', 'revoked']),
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
  payer: z.string().nullable().describe("The connection's session address, which holds its float"),
  grants: z.array(grantView).describe('Newest first. jaw_revoke_permission takes a permissionId from here'),
});

type View = z.infer<typeof connectionView>;
type GrantRow = typeof grants.$inferSelect;

function grantOf(g: GrantRow, now: Date): z.infer<typeof grantView> {
  const { spends } = g.permission as GrantedPermission;
  return {
    permissionId: g.permissionId,
    kind: g.kind,
    status: g.revokedAt ? 'revoked' : g.expiresAt <= now ? 'expired' : 'live',
    spends: spends.map((s) => ({ ...s, allowance: BigInt(s.allowance).toString() })),
    expiresAt: g.expiresAt.toISOString(),
    revokedAt: g.revokedAt?.toISOString() ?? null,
  };
}

async function viewsOf(t: Tenant, rows: (typeof connections.$inferSelect)[]): Promise<View[]> {
  const ids = rows.map((r) => r.id);
  const held = ids.length
    ? await getDb().select().from(grants).where(inArray(grants.connectionId, ids)).orderBy(desc(grants.createdAt))
    : [];
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
  }));
}

export function registerConnectionTools(server: McpServer) {
  server.registerTool(
    'jaw_connections',
    {
      description:
        'Every app connected to this account through this server, this one included, with the grants each one holds by permissionId: kind, spend limits, expiry and whether it is live, expired or revoked. ' +
        'jaw_revoke_permission revokes one; jaw_status shows what is left of the x402 budget today.',
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
      const live = views.flatMap((v) => v.grants).filter((g) => g.status === 'live').length;
      return reply({
        connections: views,
        summary: `${views.length} connection(s), ${active} active, holding ${live} live grant(s).`,
      });
    }
  );
}
