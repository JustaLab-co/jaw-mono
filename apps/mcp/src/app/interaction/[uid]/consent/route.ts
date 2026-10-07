import { consent, preflight } from '@/connections/interaction';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withEdge((req) => consent(req), { guarded: true });
export const OPTIONS = preflight;
