import { outcomeResponse, readForPage } from '@/approvals/page-api';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(async (_req, { params }) => outcomeResponse(await readForPage((await params).id)), {
  guarded: true,
  cors: true,
});
export const OPTIONS = preflight;
