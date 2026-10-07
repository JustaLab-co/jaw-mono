import { createMcpHandler } from 'mcp-handler';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mcp = createMcpHandler(() => {}, { serverInfo: { name: 'jaw', version: '0.0.1' } });

const handler = withEdge(mcp, { guarded: true });

export { handler as GET, handler as POST, handler as DELETE };
