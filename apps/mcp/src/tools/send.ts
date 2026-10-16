import { usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { encodeFunctionData, erc20Abi, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { reply } from '@/lib/fence';
import { ownerCallsOutput, sendCalls, type OwnerCallDeps, type SendResult } from './owner-calls';
import { resolveName } from './read';
import { refusal } from './reply';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;

const transferInput = z.strictObject({
  to: z.string().describe('The recipient: an address, or an ENS name such as alice.eth'),
  amount: z.string().regex(AMOUNT).describe('USDC, as a decimal such as "0.01"'),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,100}$/)
    .optional()
    .describe('Reuse it to retry this exact transfer; one is made up and returned when absent'),
});
export type TransferInput = z.infer<typeof transferInput>;

const output = ownerCallsOutput.extend({
  recipient: z.object({
    address: z.string(),
    name: z.string().nullable().describe('The ENS name the address was resolved from'),
  }),
});

type Recipient = { address: Address; name: string | null };

async function recipientOf(to: string): Promise<Recipient | string> {
  if (isAddress(to, { strict: false })) return { address: getAddress(to), name: null };
  const resolved = await resolveName(to).catch(() => undefined);
  if (!resolved) return `${to} could not be resolved as an ENS name right now. Try again, or give the address.`;
  if (!resolved.address) return `${resolved.name} does not resolve to an address.`;
  return { address: getAddress(resolved.address), name: resolved.name };
}

/** A USDC transfer from the account, asked of the owner through jaw_send_calls. */
export async function transfer(
  t: Tenant,
  { to, amount, idempotencyKey }: TransferInput,
  deps?: OwnerCallDeps
): Promise<SendResult> {
  const usdc = usdcForNetwork(`eip155:${t.chainId}`);
  if (!usdc) return refusal("USDC is not supported on this connection's chain.");
  const units = parseUnits(amount, usdc.decimals);
  if (units === 0n) return refusal('A transfer of zero sends nothing.');
  const recipient = await recipientOf(to);
  if (typeof recipient === 'string') return refusal(recipient);

  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient.address, units] });
  const asked = await sendCalls(t, { calls: [{ to: usdc.address, data }], idempotencyKey }, deps);
  const sent = asked.structuredContent;
  if (!sent) return asked;
  const what = `${amount} USDC to ${recipient.address}${recipient.name ? ` (${recipient.name})` : ''}`;
  const summary = sent.url
    ? `Ask the owner to open ${sent.url} before ${sent.approveBy} and approve sending ${what} from ${sent.from}. ` +
      `The owner pays the gas in the wallet; nothing comes out of the budget. Follow it with jaw_send_calls_status and ${sent.id}.`
    : `Transfer of ${what}. ${sent.summary}`;
  const out = output.parse({ ...sent, recipient, summary });
  return { ...reply(out), isError: asked.isError };
}

export function registerSendTools(server: McpServer) {
  server.registerTool(
    'jaw_transfer',
    {
      description:
        "Ask the account owner to send USDC from the account to an address or ENS name. The owner reviews and signs the transfer in their JAW wallet and pays the gas; nothing comes out of this connection's budget. " +
        'Returns the resolved recipient address and a link for the owner right away; follow it with jaw_send_calls_status. ' +
        'Send the same idempotencyKey to retry; a retry never asks twice.',
      inputSchema: transferInput,
      outputSchema: output,
    },
    async (input, ctx) => transfer(tenant(ctx), input)
  );
}
