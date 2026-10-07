import { createMcpHandler } from 'mcp-handler';
import { registerApprovalTools } from '@/approvals/tools';
import { withConnection } from '@/connections/auth';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mcp = createMcpHandler(registerApprovalTools, {
  serverInfo: { name: 'jaw', version: '0.0.1' },
  capabilities: { tools: {} },
});

const handler = withEdge(withConnection(mcp), { guarded: true });

export { handler as GET, handler as POST, handler as DELETE };
