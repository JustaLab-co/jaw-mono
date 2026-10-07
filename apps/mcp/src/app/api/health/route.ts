import { isPaused } from '@/db/settings';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(
  async () => {
    try {
      return Response.json({ db: 'ok', paused: await isPaused() });
    } catch {
      return Response.json({ db: 'down' }, { status: 503 });
    }
  },
  { guarded: false }
);
