import type { Call } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { getAddress, numberToHex, type Hex } from 'viem';
import { z } from 'zod';
import { askWithGas, NO_SEND_SCOPE, refusal, statusOutput } from '@/approvals/tools';
import { tenant } from '@/connections/auth';

export const MAX_CALLS = 10;

const callInput = z.strictObject({
  to: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe('The contract or account to call'),
  data: z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})*$/)
    .describe('Calldata, hex; "0x" for none'),
  value: z
    .string()
    .regex(/^\d{1,78}$/)
    .optional()
    .describe('Wei to send with the call, decimal; 0 when left out'),
});

export function registerPrepareCallsTool(server: McpServer) {
  server.registerTool(
    'jaw_prepare_calls',
    {
      description: `Prepare up to ${MAX_CALLS} calls from the account, run together on the connection's chain, for the account owner to approve with their passkey. The owner sees each call decoded when its ABI is known, raw calldata with a warning otherwise, and the gas in USDC. Returns a link for the owner and a request id; poll jaw_request_status for the transaction.`,
      inputSchema: z.strictObject({ calls: z.array(callInput).min(1).max(MAX_CALLS) }),
      outputSchema: statusOutput,
    },
    async ({ calls }, ctx) => {
      const t = tenant(ctx);
      if (!t.scopes.includes('wallet:send')) return refusal(NO_SEND_SCOPE);
      const stored: Call[] = calls.map((c) => ({
        to: getAddress(c.to),
        data: c.data as Hex,
        value: numberToHex(BigInt(c.value ?? '0')),
      }));
      return askWithGas(t, stored, (gas) => ({ kind: 'calls', calls: stored, gas }));
    }
  );
}
