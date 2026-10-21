import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRpcTool } from './handlers/rpc.js';
import { registerConfigTools } from './handlers/config.js';
import { registerDaemonTools } from './handlers/daemon.js';
import { registerSessionTools } from './handlers/session.js';
import { registerPayTool } from './handlers/pay.js';
import { registerDiscoverTool } from './handlers/discover.js';
import { registerResources } from './handlers/resources.js';

export function createMcpServer(version = '0.0.0'): McpServer {
  const server = new McpServer(
    {
      name: 'jaw',
      version,
    },
    // jaw_grant_permissions sends the wallet URL as a log message when the
    // request carries no progress token.
    { capabilities: { logging: {} } }
  );

  registerRpcTool(server);
  registerConfigTools(server);
  registerDaemonTools(server);
  registerSessionTools(server);
  registerPayTool(server);
  registerDiscoverTool(server);
  registerResources(server);

  return server;
}

export async function startMcpServer(version?: string): Promise<void> {
  const server = createMcpServer(version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
