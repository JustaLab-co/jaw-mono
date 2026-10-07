import { complete } from '@/connections/interaction';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(complete, { guarded: true });
