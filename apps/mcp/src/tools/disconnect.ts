import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant } from '@/connections/auth';
import { disconnect, disconnectOutput } from '@/connections/disconnect';

export function registerDisconnectTool(server: McpServer) {
  server.registerTool(
    'jaw_session_disconnect',
    {
      title: 'Disconnect this app from the wallet',
      description:
        "End this connection: revokes its permissions on chain, returns the USDC it was holding for fees and paid services to the owner's wallet, and ends its access, so nothing works until the owner connects again. " +
        "Use it only when the owner asks to disconnect or remove this app's access. " +
        'If it fails before anything is sent, nothing was revoked. If the transaction is sent but unconfirmed, it may still land. ' +
        'Calling it again is safe; it never repeats what already landed.',
      inputSchema: z.strictObject({}),
      outputSchema: disconnectOutput,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (_input, ctx) => disconnect(tenant(ctx))
  );
}
