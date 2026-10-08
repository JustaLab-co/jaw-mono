import { abort } from '@/connections/interaction';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(async (req, { params }) => abort(req, (await params).uid), { guarded: true });
