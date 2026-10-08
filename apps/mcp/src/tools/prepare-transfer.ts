import { transferCall, usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { getAddress, isAddress, parseUnits, type Address } from 'viem';
import { z } from 'zod';
import { askWithGas, NO_SEND_SCOPE, refusal, statusOutput } from '@/approvals/tools';
import { tenant } from '@/connections/auth';
import { resolveName } from './read';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;

/** The address to send to, and the ENS name when that is what the agent gave. */
async function recipientOf(to: string): Promise<{ address: Address; name?: string } | string> {
  if (isAddress(to, { strict: false })) return { address: getAddress(to) };
  const resolved = await resolveName(to).catch(() => undefined);
  if (!resolved) return `${to} could not be resolved as an ENS name right now. Try again, or give the address.`;
  if (!resolved.address) return `${resolved.name} does not resolve to an address.`;
  return { address: resolved.address as Address, name: resolved.name };
}

export function registerPrepareTransferTool(server: McpServer) {
  server.registerTool(
    'jaw_prepare_transfer',
    {
      description:
        "Prepare a USDC transfer from the account, on the connection's chain, for the account owner to approve with their passkey. `to` is an address or an ENS name, resolved on the server; the owner sees the name beside the address, and the gas in USDC. Returns a link for the owner and a request id; poll jaw_request_status for the transaction.",
      inputSchema: z.strictObject({
        to: z.string().describe('The recipient: an address, or an ENS name such as alice.eth'),
        amount: z.string().regex(AMOUNT).describe('USDC, as a decimal such as "0.01"'),
      }),
      outputSchema: statusOutput,
    },
    async ({ to, amount }, ctx) => {
      const t = tenant(ctx);
      if (!t.scopes.includes('wallet:send')) return refusal(NO_SEND_SCOPE);
      const usdc = usdcForNetwork(`eip155:${t.chainId}`);
      if (!usdc) return refusal("USDC is not supported on this connection's chain.");
      const units = parseUnits(amount, usdc.decimals);
      if (units === 0n) return refusal('A transfer of zero sends nothing.');
      const recipient = await recipientOf(to);
      if (typeof recipient === 'string') return refusal(recipient);
      const call = transferCall(usdc.address, recipient.address, units.toString());
      return askWithGas(t, [call], (gas) => ({
        kind: 'transfer',
        to: recipient.address,
        ...(recipient.name && { name: recipient.name }),
        token: usdc.address,
        amount: units.toString(),
        gas,
      }));
    }
  );
}
