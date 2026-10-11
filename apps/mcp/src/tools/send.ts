import { usdcForNetwork } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { sessionBridge } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { isPaymentsPaused } from '@/db/settings';
import { currentGrant, type Grant } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { FloatBusy, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import { resolveName } from './read';
import { NO_SEND_SCOPE, refusal } from './reply';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const MAX_CALLS = 10;
const RECEIPT_MS = 60_000;

type Call = { to: Address; data: Hex };

const output = z.object({
  callsId: z.string(),
  txHash: z.string().nullable(),
  status: z.enum(['landed', 'reverted', 'unconfirmed']),
  summary: z.string(),
});

const covers = (grant: Grant, call: Call) =>
  grant.permission.calls.some(
    (p) =>
      isAddressEqual(p.target as Address, call.to) && p.selector.toLowerCase() === call.data.slice(0, 10).toLowerCase()
  );

/**
 * Runs the calls from the account through this connection's permission, signed by
 * its session key. The permission manager checks each call and the spend cap on
 * chain; the float lock keeps a refill from reading the allowance mid-send.
 */
async function sendWithinBudget(t: Tenant, calls: Call[]) {
  if (await isPaymentsPaused()) return refusal('Payments are paused on this server, so nothing was sent.');
  const grant = await currentGrant(t.connectionId);
  if (!grant) return refusal('This connection has no budget yet. Ask for one with jaw_request_budget.');
  const outside = calls.find((c) => !covers(grant, c));
  if (outside) {
    return refusal(
      `The budget does not cover a call to ${outside.to} with selector ${outside.data.slice(0, 10)}. ` +
        'Ask for a budget that lists it with jaw_request_budget, passing its contract and function signature in calls.'
    );
  }
  const bridge = sessionBridge(t, grant);
  if (!bridge) return refusal('This server has no paymaster key, so it cannot pay the fee to send.');

  let out: z.infer<typeof output>;
  try {
    out = await withFloat(t.connectionId, LOCK_WAIT_MS, async () => {
      const sent = (await bridge.request('wallet_sendCalls', [{ calls }])) as { id: Hex };
      for (const until = Date.now() + RECEIPT_MS; Date.now() < until; ) {
        const status = (await bridge.request('wallet_getCallsStatus', sent.id).catch(() => undefined)) as
          | { status: number; receipts?: { transactionHash: Hex }[] }
          | undefined;
        const txHash = status?.receipts?.[0]?.transactionHash ?? null;
        if (status?.status === 200 && txHash)
          return { callsId: sent.id, txHash, status: 'landed' as const, summary: `Sent in ${txHash}.` };
        if (status && status.status >= 400) {
          return {
            callsId: sent.id,
            txHash,
            status: 'reverted' as const,
            summary: 'Reverted on chain. Nothing was sent.',
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return {
        callsId: sent.id,
        txHash: null,
        status: 'unconfirmed' as const,
        summary: `Submitted as ${sent.id} and not confirmed yet. Check it before sending again, or it may land twice.`,
      };
    });
  } catch (err) {
    if (err instanceof FloatBusy) return refusal('A payment on this connection is in progress. Try again in a moment.');
    log('warn', { msg: 'send not submitted', error: errorLabel(err) });
    return refusal('Nothing was sent: the calls failed in simulation, or are over what the budget has left today.');
  }
  return {
    content: [{ type: 'text' as const, text: out.summary }],
    structuredContent: out,
    isError: out.status === 'reverted',
  };
}

async function recipientOf(to: string): Promise<Address | string> {
  if (isAddress(to, { strict: false })) return getAddress(to);
  const resolved = await resolveName(to).catch(() => undefined);
  if (!resolved) return `${to} could not be resolved as an ENS name right now. Try again, or give the address.`;
  return resolved.address ? (resolved.address as Address) : `${resolved.name} does not resolve to an address.`;
}

export function registerSendTools(server: McpServer) {
  server.registerTool(
    'jaw_transfer',
    {
      description:
        "Send USDC from the account to an address or ENS name, out of this connection's daily budget. No prompt to the owner: the budget they approved is the limit.",
      inputSchema: z.strictObject({
        to: z.string().describe('The recipient: an address, or an ENS name such as alice.eth'),
        amount: z.string().regex(AMOUNT).describe('USDC, as a decimal such as "0.01"'),
      }),
      outputSchema: output,
    },
    async ({ to, amount }, ctx) => {
      const t = tenant(ctx);
      if (!t.scopes.includes('wallet:send')) return refusal(NO_SEND_SCOPE);
      const usdc = usdcForNetwork(`eip155:${t.chainId}`);
      if (!usdc) return refusal("USDC is not supported on this connection's chain.");
      const units = parseUnits(amount, usdc.decimals);
      if (units === 0n) return refusal('A transfer of zero sends nothing.');
      const recipient = await recipientOf(to);
      if (!isAddress(recipient)) return refusal(recipient);
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, units] });
      return sendWithinBudget(t, [{ to: usdc.address, data }]);
    }
  );

  server.registerTool(
    'jaw_send_calls',
    {
      description: `Run up to ${MAX_CALLS} contract calls from the account, together, within this connection's budget. Only calls the budget lists are allowed (see jaw_request_budget); no prompt to the owner. Calls carry no ETH.`,
      inputSchema: z.strictObject({
        calls: z
          .array(
            z.strictObject({
              to: z
                .string()
                .regex(/^0x[0-9a-fA-F]{40}$/)
                .describe('The contract to call'),
              data: z
                .string()
                .regex(/^0x[0-9a-fA-F]{8}([0-9a-fA-F]{2})*$/)
                .describe('Calldata, hex, starting with the function selector'),
            })
          )
          .min(1)
          .max(MAX_CALLS),
      }),
      outputSchema: output,
    },
    async ({ calls }, ctx) => {
      const t = tenant(ctx);
      if (!t.scopes.includes('wallet:send')) return refusal(NO_SEND_SCOPE);
      return sendWithinBudget(
        t,
        calls.map((c) => ({ to: getAddress(c.to), data: c.data as Hex }))
      );
    }
  );
}
