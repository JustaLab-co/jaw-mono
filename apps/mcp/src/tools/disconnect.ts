import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant } from '@/connections/auth';
import { disconnect, disconnectOutput } from '@/connections/disconnect';

export function registerDisconnectTool(server: McpServer) {
  server.registerTool(
    'jaw_disconnect',
    {
      description:
        'End this connection. Revokes its budgets on chain, returns the USDC float to the account owner, ' +
        'and invalidates its tokens, so every later call fails until the owner connects again. ' +
        'If it fails before the transaction is sent, nothing was revoked. If the transaction is sent but unconfirmed, ' +
        'it may still land. Either way calling it again is safe, since it does not repeat what already landed.',
      inputSchema: z.strictObject({}),
      outputSchema: disconnectOutput,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (_input, ctx) => disconnect(tenant(ctx))
  );
}
