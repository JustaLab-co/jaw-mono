import type { McpServer } from '@modelcontextprotocol/server';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { endConnection, ownedBy } from '@/connections/rows';
import { getDb } from '@/db/client';
import { connections, grants } from '@/db/schema';
import { FloatBusy, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import { refusal } from './reply';

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
  budget: z
    .object({ permissionId: z.string(), perDay: z.string().describe('USDC base units'), expiresAt: z.string() })
    .nullable()
    .describe('The budget in force, if any'),
});

type View = z.infer<typeof connectionView>;

async function viewsOf(t: Tenant, rows: (typeof connections.$inferSelect)[]): Promise<View[]> {
  const ids = rows.map((r) => r.id);
  const budgets = ids.length
    ? await getDb().select().from(grants).where(inArray(grants.connectionId, ids)).orderBy(desc(grants.createdAt))
    : [];
  const now = new Date();
  return rows.map((row) => {
    // Newest first, so the first unreplaced one is the budget in force.
    const budget = budgets.find((g) => g.connectionId === row.id && !g.replacedAt && !g.revokedAt && g.expiresAt > now);
    return {
      id: row.id,
      current: row.id === t.connectionId,
      client: row.clientName,
      scopes: row.scopes,
      status: row.status === 'active' && row.expiresAt <= now ? 'expired' : (row.status as View['status']),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      payer: row.sessionAddress,
      budget: budget
        ? { permissionId: budget.permissionId, perDay: budget.allowance, expiresAt: budget.expiresAt.toISOString() }
        : null,
    };
  });
}

const reply = <T extends object>(summary: string, structured: T) => ({
  content: [{ type: 'text' as const, text: summary }],
  structuredContent: { ...structured, summary },
});

export function registerConnectionTools(server: McpServer) {
  server.registerTool(
    'jaw_connections',
    {
      description:
        "Every app connected to this account through this server, this one included, with each one's budget.",
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
      const live = views.filter((v) => v.status === 'active').length;
      return reply(`${views.length} connection(s), ${live} active.`, { connections: views });
    }
  );

  server.registerTool(
    'jaw_revoke_connection',
    {
      description:
        "End another app's connection to this account: its tokens stop working and its session key is gone, so its budget can no longer be spent. To end this connection, and return its float, use jaw_disconnect.",
      inputSchema: z.strictObject({ id: z.string().max(64).describe('From jaw_connections') }),
      outputSchema: z.object({ connection: connectionView, summary: z.string() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }, ctx) => {
      const t = tenant(ctx);
      if (id === t.connectionId)
        return refusal('That is this connection. Use jaw_disconnect, which also returns its float.');
      // Read before the lock, so nobody can queue on the float of a connection that is not theirs.
      const [owned] = await getDb()
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, id), ownedBy(t.account), ne(connections.status, 'pending')));
      if (!owned) return refusal('No such connection for this account.');
      let row;
      try {
        // After the funding turn in flight, so nothing is mid-refill when its key goes.
        row = await withFloat(id, LOCK_WAIT_MS, (hold) =>
          hold.tx((tx) => endConnection(id, t.account, new Date(), tx))
        );
      } catch (err) {
        if (err instanceof FloatBusy) return refusal('That connection is paying right now. Try again in a moment.');
        throw err;
      }
      if (!row) return refusal('No such connection for this account.');
      const [view] = await viewsOf(t, [row]);
      const until = view.budget
        ? ` Its budget stays approved on chain until ${view.budget.expiresAt}, with no key left to spend it.`
        : '';
      return reply(`Revoked ${view.client}.${until}`, { connection: view });
    }
  );
}
