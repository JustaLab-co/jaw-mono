import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant } from '@/connections/auth';
import { reply } from '@/lib/fence';
import { counted } from '@/lib/owner-text';
import { sendHistory, type SendRow } from '@/payments/sends';
import { history, stateOf, type PaymentRow } from '@/payments/store';

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

const executeRow = z.object({
  sendId: z.string(),
  permissionId: z.string(),
  idempotencyKey: z.string().nullable(),
  state: z
    .enum(['open', 'landed', 'released'])
    .describe('open until it lands; released when it reverted, was never sent, or was not seen on chain in time'),
  token: z.string().nullable().describe('What amount counts; null when the run moved no token'),
  amount: z.string().describe('Base units of token'),
  userOpHash: z.string().nullable(),
  txHash: z.string().nullable(),
  createdAt: z.string(),
});

const historyOutput = z.object({
  payments: z.array(row).describe('Empty on a page asked for by `executesBefore` alone'),
  next: z.string().optional().describe('Pass as `before` for the next page'),
  executes: z
    .array(executeRow)
    .describe(
      'The newest session executes, one row per token a run moved; empty on a page asked for by `before` alone'
    ),
  executesNext: z.string().optional().describe('Pass as `executesBefore` for the next page of executes'),
  summary: z.string(),
});

const executeShown = (r: SendRow): z.infer<typeof executeRow> => ({
  sendId: r.id,
  permissionId: r.permissionId,
  idempotencyKey: r.idempotencyKey,
  state: r.state,
  token: r.token,
  amount: r.amount,
  userOpHash: r.callsId,
  txHash: r.txHash,
  createdAt: r.createdAt.toISOString(),
});

const shown = (r: PaymentRow): z.infer<typeof row> => ({
  paymentId: r.id,
  idempotencyKey: r.idempotencyKey,
  host: new URL(r.url).host,
  state: stateOf(r),
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

/** How many payments and runs, newest first, and how many have no final outcome yet. A run that moved two tokens is two rows. */
function summaryOf(payments: z.infer<typeof row>[], executes: SendRow[]) {
  const runs = new Set(executes.map((r) => r.idempotencyKey ?? r.id)).size;
  const open = new Set(executes.filter((r) => r.state === 'open').map((r) => r.idempotencyKey ?? r.id)).size;
  const pending = payments.filter((p) => ['pending', 'signed', 'unknown'].includes(p.state)).length + open;
  if (!payments.length && !runs) return 'No payments or runs yet.';
  return `${counted(payments.length, 'payment')} and ${counted(runs, 'run')}, newest first.${pending ? ` ${pending} still pending.` : ''}`;
}

export function registerHistoryTool(server: McpServer) {
  server.registerTool(
    'jaw_session_history',
    {
      title: "This connection's payments and runs",
      description:
        'What this connection paid for and ran on its own, newest first, with the state of each. Use it when the owner ' +
        'asks what the agent spent or did without them, and to follow a payment or run whose outcome was still pending. ' +
        'Two lists, each with its own cursor: `before` takes `next` for payments, `executesBefore` takes `executesNext` ' +
        "for runs. The wallet's own transactions are in jaw_get_calls_history.",
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(50).optional(),
        before: z.string().optional().describe('The `next` value of the previous page'),
        executesBefore: z.string().optional().describe('The `executesNext` value of the previous page'),
      }),
      outputSchema: historyOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ limit = 20, before, executesBefore }, ctx) => {
      const { connectionId } = tenant(ctx);
      // Each list pages on its own cursor: a page asked for by one cursor alone leaves the other list out.
      const rows = executesBefore && !before ? [] : await history(connectionId, limit, before);
      const executes = before && !executesBefore ? [] : await sendHistory(connectionId, limit, executesBefore);
      const payments = rows.map(shown);
      return reply(
        historyOutput.parse({
          payments,
          ...(rows.length === limit && { next: rows[rows.length - 1].id }),
          executes: executes.map(executeShown),
          ...(executes.length === limit && { executesNext: executes[executes.length - 1].id }),
          summary: summaryOf(payments, executes),
        })
      );
    }
  );
}
