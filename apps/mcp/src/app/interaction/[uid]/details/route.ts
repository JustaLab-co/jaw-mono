import { details, preflight } from '@/connections/interaction';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(details, { guarded: true });
export const OPTIONS = preflight;
