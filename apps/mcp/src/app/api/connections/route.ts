import { config } from '@/connections/config';
import { listFromPage, pageResponse } from '@/connections/page';
import { readJson, tooLarge } from '@/lib/body';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// What the page signs to sign in.
export const GET = withEdge(async () => Response.json({ issuer: config().issuer, chainId: config().chain.id }), {
  guarded: true,
  cors: true,
});

export const POST = withEdge(
  async (req) => {
    const post = await readJson(req);
    return post === undefined ? tooLarge() : pageResponse(await listFromPage(post));
  },
  { guarded: true, cors: true }
);
export const OPTIONS = preflight;
