import { and, count, inArray, lt } from 'drizzle-orm';
import { wrapPastWindow } from '@/connections/adapter';
import { getDb } from '@/db/client';
import { oauthPayloads, payments } from '@/db/schema';
import { hasCronSecret } from '@/lib/cron';
import { withEdge } from '@/lib/edge';
import { unauthorizedCounts } from '@/lib/metrics';
import { stateOf } from '@/payments/store';
import { RECONCILE_AFTER_MS } from '@/reconciler/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const label = (value: string) => value.replace(/["\\\n]/g, '_');

export const GET = withEdge(
  async (req) => {
    if (!hasCronSecret(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const db = getDb();
    const byState = new Map<string, number>();
    const rows = await db
      .select({ state: payments.state, kind: payments.kind, n: count() })
      .from(payments)
      .groupBy(payments.state, payments.kind);
    for (const r of rows) byState.set(stateOf(r), (byState.get(stateOf(r)) ?? 0) + r.n);
    const [backlog] = await db
      .select({ n: count() })
      .from(payments)
      .where(
        and(
          inArray(payments.state, ['signed', 'unknown']),
          lt(payments.signedAt, new Date(Date.now() - RECONCILE_AFTER_MS))
        )
      );
    const [exposed] = await db.select({ n: count() }).from(oauthPayloads).where(wrapPastWindow);
    const lines = [
      '# TYPE jaw_mcp_payments gauge',
      ...[...byState].map(([state, n]) => `jaw_mcp_payments{state="${state}"} ${n}`),
      '# TYPE jaw_mcp_payments_backlog gauge',
      `jaw_mcp_payments_backlog ${backlog.n}`,
      '# TYPE jaw_mcp_wraps_past_window gauge',
      `jaw_mcp_wraps_past_window ${exposed.n}`,
      '# TYPE jaw_mcp_unauthorized_total counter',
      ...[...unauthorizedCounts()].map(([client, n]) => `jaw_mcp_unauthorized_total{client="${label(client)}"} ${n}`),
    ];
    return new Response(`${lines.join('\n')}\n`, { headers: { 'content-type': 'text/plain; version=0.0.4' } });
  },
  { guarded: false }
);
