import { decideFromPage, outcomeResponse } from '@/approvals/page-api';
import { pageCors, preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withEdge(
  async (req) => {
    const id = new URL(req.url).pathname.split('/')[3];
    return pageCors(outcomeResponse(await decideFromPage(id, await req.json().catch(() => undefined))));
  },
  { guarded: true }
);
export const OPTIONS = preflight;
