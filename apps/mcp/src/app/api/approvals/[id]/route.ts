import { outcomeResponse, readForPage } from '@/approvals/page-api';
import { pageCors, preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(
  async (req) => pageCors(outcomeResponse(await readForPage(new URL(req.url).pathname.split('/')[3]))),
  { guarded: true }
);
export const OPTIONS = preflight;
