import { openSession } from '@/connections/interaction';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withEdge(async (req, { params }) => openSession(req, (await params).uid), { guarded: true });
