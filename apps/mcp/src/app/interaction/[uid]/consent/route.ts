import { consent } from '@/connections/interaction';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withEdge(async (req, { params }) => consent(req, (await params).uid), {
  guarded: true,
  cors: true,
});
export const OPTIONS = preflight;
