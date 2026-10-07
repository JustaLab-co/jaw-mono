import { getDb } from '@/db/client';
import { auditEvents } from '@/db/schema';

export interface ToolCall {
  connectionId: string;
  tool: string;
  outcome: 'ok' | 'error';
  requestId: string | undefined;
}

export async function recordToolCall(call: ToolCall): Promise<void> {
  await getDb().insert(auditEvents).values(call);
}
