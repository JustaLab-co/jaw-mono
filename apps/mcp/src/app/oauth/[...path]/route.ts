import { oauth } from '@/connections/provider';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(oauth, { guarded: true });
export const POST = GET;
