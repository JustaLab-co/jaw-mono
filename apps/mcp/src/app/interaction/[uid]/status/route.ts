import { status } from '@/connections/interaction';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(async (req, { params }) => status(req, (await params).uid), { guarded: true });
