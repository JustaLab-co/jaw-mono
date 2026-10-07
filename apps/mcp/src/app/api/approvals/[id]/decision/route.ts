import { decideFromPage, outcomeResponse } from '@/approvals/page-api';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withEdge(
  async (req, { params }) =>
    outcomeResponse(await decideFromPage((await params).id, await req.json().catch(() => undefined))),
  { guarded: true, cors: true }
);
export const OPTIONS = preflight;
