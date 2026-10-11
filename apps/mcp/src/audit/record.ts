import type { McpServer } from '@modelcontextprotocol/server';
import { tenant } from '@/connections/auth';
import { getDb } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { currentRequestId, errorLabel, log } from '@/lib/edge';
import { gateCode } from '@/payments/render';

type Payment = { state?: string; refusal?: { code: string } };
type Answer = {
  isError?: boolean;
  structuredContent?: Payment & { payment?: Payment };
  [gateCode]?: string;
};

/** A refusal code means nothing was paid; a payment that may have reached the seller is `unknown`. */
function outcomeOf(tool: string, answer: Answer): string {
  if (answer[gateCode]) return answer[gateCode];
  if (answer.isError) return 'error';
  let payment: Payment | undefined;
  if (tool === 'jaw_pay_and_fetch') payment = answer.structuredContent;
  if (tool === 'jaw_request_status') payment = answer.structuredContent?.payment;
  if (!payment || !payment.refusal) return 'ok';
  return payment.state === 'signed' || payment.state === 'unknown' ? 'unknown' : payment.refusal.code;
}

/**
 * Records one event per tool call. Applied before guardTools, so it sees the
 * guarded handler, which answers a throw as an error instead of throwing.
 */
export function auditTools(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
    register(name, config, async (...args: unknown[]) => {
      const result = (await handler(...args)) as Answer;
      const { connectionId } = tenant(args.at(-1) as Parameters<typeof tenant>[0]);
      // Never fails the call: the tool may already have moved money, and its answer matters more than the record.
      await getDb()
        .insert(auditEvents)
        .values({
          connectionId,
          tool: name,
          outcome: outcomeOf(name, result),
          requestId: currentRequestId(),
        })
        .catch((err) => log('error', { msg: 'audit record failed', error: errorLabel(err) }));
      return result;
    })) as typeof server.registerTool;
}
