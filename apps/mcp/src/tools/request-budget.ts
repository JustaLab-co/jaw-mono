import { randomBytes } from 'node:crypto';
import { openRequest, usdcForNetwork, type ApprovalId, type ApprovalRequest } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { parseUnits, type Address } from 'viem';
import { z } from 'zod';
import { describe, MAX_PENDING, refusal, result, statusOutput } from '@/approvals/tools';
import { insertUnderCap } from '@/approvals/store';
import { tenant } from '@/connections/auth';
import { CONNECTION_TTL_MS } from '@/connections/rows';

export const PER_DAY = /^\d{1,9}(\.\d{1,6})?$/;

interface Asker {
  account: Address;
  chainId: number;
  clientName: string;
  clientId: string;
  sessionAddress: Address;
}

/** A pending approval for a daily USDC allowance to the connection's session key, or why there is none. */
export function budgetRequest(c: Asker, perDay: string, now: Date): ApprovalRequest | 'no_usdc' | 'zero' {
  const usdc = usdcForNetwork(`eip155:${c.chainId}`);
  if (!usdc) return 'no_usdc';
  const allowance = parseUnits(perDay, usdc.decimals);
  if (allowance === 0n) return 'zero';
  return openRequest(
    {
      id: randomBytes(16).toString('base64url') as ApprovalId,
      account: c.account,
      chainId: c.chainId,
      requester: { name: c.clientName, clientId: c.clientId },
      sessionAddress: c.sessionAddress,
      body: {
        kind: 'budget',
        spender: c.sessionAddress,
        token: usdc.address,
        allowance: allowance.toString(),
        expiry: Math.floor((now.getTime() + CONNECTION_TTL_MS) / 1000),
      },
    },
    now
  );
}

const REFUSALS = {
  no_usdc: "USDC is not supported on this connection's chain.",
  zero: 'A budget of zero would refuse every payment.',
};

export function registerBudgetTool(server: McpServer) {
  server.registerTool(
    'jaw_request_budget',
    {
      description:
        'Ask the account owner for a daily USDC budget this connection can pay x402 services from. Returns a link for the owner to approve with their passkey; poll jaw_request_status. A new budget replaces the current one.',
      inputSchema: z.strictObject({
        perDay: z.string().regex(PER_DAY).describe('USDC per day, as a decimal such as "1" or "0.5"'),
      }),
      outputSchema: statusOutput,
    },
    async ({ perDay }, ctx) => {
      const t = tenant(ctx);
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
