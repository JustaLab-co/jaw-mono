import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpError, mcpResult } from '@jaw.id/agent';
import { shutdownDaemon } from '../../lib/bridge-singleton.js';
import { loadRelaySession } from '../../lib/relay-session.js';
import { loadConfig, redactConfig } from '../../lib/config.js';

export function registerDaemonTools(server: McpServer): void {
  server.registerTool(
    'jaw_status',
    {
      description:
        'Check the current status of the JAW.id relay bridge — whether a browser-paired relay ' +
        'session exists (established key exchange) and what configuration is in use. ' +
        'Each jaw_rpc call connects on demand, so there is no persistent connection to report.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        // A session without a peer key never completed the browser key exchange;
        // getBridge discards it, so report it as absent.
        const relaySession = loadRelaySession();
        const established = relaySession !== null && relaySession.peerPublicKey !== null;

        const status = {
          relay: established ? { session: true, startedAt: relaySession.startedAt } : { session: false },
          config: redactConfig(loadConfig()),
        };

        return mcpResult(status);
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  server.registerTool(
    'jaw_disconnect',
    {
      description:
        'Close the relay session and browser tab. ' +
        'Call this when you are done making wallet requests to clean up resources.',
    },
    async () => {
      try {
        await shutdownDaemon();
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Relay session closed and browser tab dismissed.',
            },
          ],
        };
      } catch (err) {
        return mcpError(err);
      }
    }
  );
}
