import { details } from '@/connections/interaction';
import { preflight } from '@/lib/cors';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(details, { guarded: true });
export const OPTIONS = preflight;
