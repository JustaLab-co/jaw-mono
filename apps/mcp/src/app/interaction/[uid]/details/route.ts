import { details } from '@/connections/interaction';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(async (req, { params }) => details(req, (await params).uid), { guarded: true, cors: true });
export const OPTIONS = preflight;
