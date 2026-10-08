import { hasCronSecret } from '@/lib/cron';
import { withEdge } from '@/lib/edge';
import { purge, reconcile } from '@/reconciler/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const run = withEdge(
  async (req) => {
    if (!hasCronSecret(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const report = await reconcile();
    await purge();
    return Response.json(report);
  },
  { guarded: false }
);

export { run as GET, run as POST };
