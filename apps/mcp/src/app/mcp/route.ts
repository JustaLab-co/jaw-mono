import { createMcpHandler } from 'mcp-handler';
import { registerApprovalTools } from '@/approvals/tools';
import { connectionKey, withConnection } from '@/connections/auth';
import { withEdge } from '@/lib/edge';
import { registerReadTools } from '@/tools/read';
import { registerHistoryTool } from '@/tools/history';
import { registerPayTool } from '@/tools/pay-and-fetch';
import { registerBudgetTool } from '@/tools/request-budget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mcp = createMcpHandler(
  (server) => {
    registerReadTools(server);
    registerApprovalTools(server);
    registerBudgetTool(server);
    registerPayTool(server);
    registerHistoryTool(server);
  },
  {
    serverInfo: { name: 'jaw', version: '0.0.1' },
    capabilities: { tools: {} },
  }
);

// Bearer tokens, no cookies: any origin may call, so browser-based MCP clients work.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id, x-request-id',
};

const edge = withEdge(withConnection(mcp), { guarded: true, rateKey: connectionKey });

const handler: typeof edge = async (req, ctx) => {
  const res = await edge(req, ctx);
  for (const [name, value] of Object.entries(CORS)) res.headers.set(name, value);
  return res;
};

export { handler as GET, handler as POST, handler as DELETE };

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' },
  });
}
