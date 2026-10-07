import { decideFromPage, outcomeResponse } from '@/approvals/page-api';
import { readJson, tooLarge } from '@/lib/body';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withEdge(
  async (req, { params }) => {
    const post = await readJson(req);
    return post === undefined ? tooLarge() : outcomeResponse(await decideFromPage((await params).id, post));
  },
  { guarded: true, cors: true }
);
export const OPTIONS = preflight;
