import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant } from '@/connections/auth';
import { reply } from '@/lib/fence';
import { history, type PaymentRow } from '@/payments/store';

const row = z.object({
  paymentId: z.string(),
  idempotencyKey: z.string(),
  host: z.string(),
  state: z.enum(['pending', 'signed', 'settled', 'failed', 'unknown']),
  kind: z.enum(['free', 'paid', 'refused', 'failed']).nullable(),
  code: z.string().nullable(),
  amount: z.string().nullable(),
  authorized: z.string().nullable(),
  asset: z.string().nullable().describe('CAIP-19 asset id'),
  payTo: z.string().nullable(),
  txHash: z.string().nullable(),
  blockTime: z.string().nullable(),
  topUp: z.string().nullable().describe('Base units moved into the payer before this payment'),
  createdAt: z.string(),
});

const historyOutput = z.object({
  payments: z.array(row),
  next: z.string().optional().describe('Pass as `before` for the next page'),
  summary: z.string(),
});

const shown = (r: PaymentRow): z.infer<typeof row> => ({
  paymentId: r.id,
  idempotencyKey: r.idempotencyKey,
  host: new URL(r.url).host,
  state: r.state,
  kind: r.kind,
  code: r.code,
  amount: r.amount,
  authorized: r.authorized,
  asset: r.network && r.asset ? `${r.network}/erc20:${r.asset}` : null,
  payTo: r.payTo,
  txHash: r.txHash,
  blockTime: r.blockTime?.toISOString() ?? null,
  topUp: r.topUpAmount,
  createdAt: r.createdAt.toISOString(),
});

export function registerHistoryTool(server: McpServer) {
  server.registerTool(
    'jaw_history',
    {
      description: 'The payments this connection made, newest first, with their state and transaction hash.',
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(50).optional(),
        before: z.string().optional().describe('The `next` value of the previous page'),
      }),
      outputSchema: historyOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ limit = 20, before }, ctx) => {
      const rows = await history(tenant(ctx).connectionId, limit, before);
      const settled = rows.filter((r) => r.state === 'settled' && r.kind === 'paid').length;
      return reply(
        historyOutput.parse({
          payments: rows.map(shown),
          ...(rows.length === limit && { next: rows[rows.length - 1].id }),
          summary: `${rows.length} payments, ${settled} settled.`,
        })
      );
    }
  );
}
