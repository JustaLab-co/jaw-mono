import type { McpServer } from '@modelcontextprotocol/server';
import { tenant } from '@/connections/auth';
import { getDb } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { currentRequestId, errorLabel, log } from '@/lib/edge';

/**
 * Records one event per tool call. Applied before guardTools, so it sees the
 * guarded handler, which answers a throw as an error instead of throwing.
 */
export function auditTools(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
    register(name, config, async (...args: unknown[]) => {
      const result = (await handler(...args)) as {
        isError?: boolean;
        structuredContent?: { refusal?: { code: string } };
      };
      const { connectionId } = tenant(args.at(-1) as Parameters<typeof tenant>[0]);
      // Never fails the call: the tool may already have moved money, and its answer matters more than the record.
      await getDb()
        .insert(auditEvents)
        .values({
          connectionId,
          tool: name,
          // A payment refusal answers without isError, so its code is the outcome.
          outcome: result.isError ? 'error' : (result.structuredContent?.refusal?.code ?? 'ok'),
          requestId: currentRequestId(),
        })
        .catch((err) => log('error', { msg: 'audit record failed', error: errorLabel(err) }));
      return result;
    })) as typeof server.registerTool;
}
