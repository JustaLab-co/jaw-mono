import { config } from '@/connections/config';
import { isPaused } from '@/db/settings';
import { log, withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(
  async () => {
    try {
      config();
    } catch (err) {
      log('error', { msg: 'configuration invalid', error: err instanceof Error ? err.message : 'unknown' });
      return Response.json({ config: 'invalid' }, { status: 503 });
    }
    try {
      return Response.json({ db: 'ok', paused: await isPaused() });
    } catch {
      return Response.json({ db: 'down' }, { status: 503 });
    }
  },
  { guarded: false }
);
