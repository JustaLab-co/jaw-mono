import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describe, NO_SEND_SCOPE, refusal, result, statusOutput } from '@/approvals/tools';
import { insertUnderCap, MAX_PENDING } from '@/approvals/store';
import { tenant } from '@/connections/auth';
import { budgetRequest, PER_DAY } from '@/grants/request';

const REFUSALS = {
  no_usdc: "USDC is not supported on this connection's chain.",
  zero: 'A budget of zero would refuse every payment.',
};

export function registerBudgetTool(server: McpServer) {
  server.registerTool(
    'jaw_request_budget',
    {
      description:
        'Ask the account owner for a daily USDC budget this connection can pay x402 services from. Returns a link for the owner to approve with their passkey; poll jaw_request_status. A new budget becomes the one this connection spends from; the earlier permission stays approved on chain until it ends.',
      inputSchema: z.strictObject({
        perDay: z.string().regex(PER_DAY).describe('USDC per day, as a decimal such as "1" or "0.5"'),
      }),
      outputSchema: statusOutput,
    },
    async ({ perDay }, ctx) => {
      const t = tenant(ctx);
      if (!t.scopes.includes('wallet:send')) return refusal(NO_SEND_SCOPE);
      const request = budgetRequest(t, perDay, new Date());
      if (typeof request === 'string') return refusal(REFUSALS[request]);
      if (!(await insertUnderCap(t.connectionId, request, MAX_PENDING))) {
        return refusal(
          `This connection already has ${MAX_PENDING} requests waiting. Wait for them or let them expire.`
        );
      }
      return result(describe(request));
    }
  );
}
