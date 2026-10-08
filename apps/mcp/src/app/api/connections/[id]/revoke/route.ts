import { pageResponse, revokeFromPage } from '@/connections/page';
import { readJson, tooLarge } from '@/lib/body';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withEdge(
  async (req, { params }) => {
    const post = await readJson(req);
    return post === undefined ? tooLarge() : pageResponse(await revokeFromPage((await params).id, post));
  },
  { guarded: true, cors: true }
);
export const OPTIONS = preflight;
