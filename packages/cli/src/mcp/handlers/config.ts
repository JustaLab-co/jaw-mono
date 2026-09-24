import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configSetSchema } from '../tools.js';
import { mcpError, mcpResult } from '../helpers.js';
import { loadConfig, setConfigValue, redactConfig } from '../../lib/config.js';
import type { z } from 'zod';

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    'jaw_config_show',
    {
      description: 'Show current CLI configuration (secrets redacted).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return mcpResult(redactConfig(loadConfig()));
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // The SDK's registerTool generic inference is excessively deep for this schema
  // and trips TS2589 in some TS builds but not others, which makes a
  // `@ts-expect-error` unreliable (it flips to "unused" where it doesn't fire).
  // Call it through an explicit signature so the deep instantiation never happens.
  type RegisterConfigSet = (
    name: string,
    config: { description: string; inputSchema: typeof configSetSchema },
    // Typed from the schema, so the URL keys it leaves out are a type error here too.
    handler: (params: { key: z.infer<typeof configSetSchema.key>; value: string }) => Promise<unknown>
  ) => void;
  (server.registerTool as unknown as RegisterConfigSet)(
    'jaw_config_set',
    {
      description: 'Set a CLI configuration value (apiKey, defaultChain, ens, sessionExpiry).',
      inputSchema: configSetSchema,
    },
    async (params) => {
      try {
        setConfigValue(params.key, params.value);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Set ${params.key} successfully`,
            },
          ],
        };
      } catch (err) {
        return mcpError(err);
      }
    }
  );
}
