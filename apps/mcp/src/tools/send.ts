import { usdcForNetwork, type SessionBridge } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
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
import { chainClients, sessionBridge } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { isLive } from '@/connections/rows';
import { connections } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { currentGrant, type Grant } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { dayLeft, readDaySpend } from '@/payments/day-spend';
import { FloatBusy, FloatLost, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import { handToReconciler, noteCallsId, recordedSends, recordSend, settleSend } from '@/payments/sends';
import { entriesFor } from '@/payments/store';
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

// Core simulates the batch to size the paymaster approval, which is where a call the
// budget refuses reverts, and throws this before anything reaches the bundler.
const refusedInSimulation = (err: unknown) =>
  err instanceof Error && err.message.includes('Could not size the ERC-20 paymaster approval');

const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const TRANSFER = '0xa9059cbb';
const TRANSFER_FROM = '0x23b872dd';
const APPROVE = '0x095ea7b3';
const INCREASE_ALLOWANCE = '0x39509351';
const PERMIT2_APPROVE = '0x87517c45';

// The 32-byte word at a calldata offset, zero padded past the end as the EVM reads it.
const word = (data: Hex, offset: number) => BigInt(`0x${data.slice(2 + offset * 2, 66 + offset * 2).padEnd(64, '0')}`);
const isAt = (data: Hex, offset: number, address: Address) => word(data, offset) % 2n ** 160n === BigInt(address);

function usdcThePermissionCounts(calls: Call[], grant: Grant): bigint {
  let sum = 0n;
  for (const { to, data } of calls) {
    const selector = data.slice(0, 10).toLowerCase();
    if (isAddressEqual(to, grant.token)) {
      if (selector === TRANSFER || selector === APPROVE || selector === INCREASE_ALLOWANCE) sum += word(data, 0x24);
      if (selector === TRANSFER_FROM && isAt(data, 0x04, grant.account)) sum += word(data, 0x44);
    }
    if (isAddressEqual(to, PERMIT2) && selector === PERMIT2_APPROVE && isAt(data, 0x04, grant.token)) {
      sum += word(data, 0x44);
    }
  }
  return sum;
}

const UNREADABLE = 'Nothing was sent: the budget could not be read from the chain right now.';

const OVER_DAY =
  "Nothing was sent: this would pass what today's budget has left after payments, transfers and calls. " +
  'Ask for a larger budget with jaw_request_budget.';

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

  let out: z.infer<typeof output> | { refused: string };
  let submitting = false;
  try {
    out = await withFloat(t.connectionId, LOCK_WAIT_MS, async (hold) => {
      // A send that verified its bearer before a disconnect may get its turn after it.
      const live = await hold.tx(async (tx) => {
        if (!(await hold.owns(tx))) throw new FloatLost();
        const [row] = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(and(eq(connections.id, t.connectionId), isLive()));
        return Boolean(row);
      });
      if (!live) return { refused: 'This connection has ended, so nothing was sent.' };
      const moving = usdcThePermissionCounts(calls, grant);
      let sendId: string | undefined;
      if (moving > 0n) {
        const { entries, sent } = await hold.tx(async (tx) => ({
          entries: await entriesFor(grant.permissionId, tx),
          sent: await recordedSends(grant.permissionId, tx),
        }));
        const day = await readDaySpend(grant, t.sessionAddress, entries, sent, chainClients);
        const head = await chainClients
          .publicClient(grant.chainId)
          .getBlockNumber()
          .catch(() => undefined);
        if (!day || head === undefined) return { refused: UNREADABLE };
        if (moving > dayLeft(BigInt(grant.allowance), day)) return { refused: OVER_DAY };
        sendId = await hold.tx(async (tx) => {
          if (!(await hold.owns(tx))) throw new FloatLost();
          return recordSend(tx, {
            connectionId: t.connectionId,
            permissionId: grant.permissionId,
            chainId: grant.chainId,
            sender: t.sessionAddress,
            amount: moving,
            periodStart: day.periodStart,
            fromBlock: head,
          });
        });
      }
      try {
        hold.assertHeld();
        submitting = true;
        const sent = (await bridge.request('wallet_sendCalls', [{ calls }])) as { id: Hex };
        if (sendId) await noteCallsId(sendId, sent.id).catch(logFailure('send calls id write failed'));
        const done = await receiptOf(bridge, sent.id);
        if (sendId) await concludeSend(sendId, done).catch(logFailure('send conclusion write failed'));
        return done;
      } catch (err) {
        const unsent = !submitting || refusedInSimulation(err);
        if (sendId) {
          await (unsent ? settleSend(sendId, { state: 'released' }) : handToReconciler(sendId)).catch(
            logFailure('send conclusion write failed')
          );
        }
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof FloatBusy) return refusal('A payment on this connection is in progress. Try again in a moment.');
    if (err instanceof FloatLost) return refusal('Nothing was sent: this send lost its turn on the budget. Try again.');
    // A timed out or dropped answer can come after the bundler took the operation.
    if (submitting && !refusedInSimulation(err)) {
      log('warn', { msg: 'send may have been submitted', error: errorLabel(err) });
      return refusal(
        'This send failed and may have been sent anyway. Check it before sending again, or it may land twice.'
      );
    }
    log('warn', { msg: 'send not submitted', error: errorLabel(err) });
    return refusal('Nothing was sent: the calls failed in simulation, or are over what the budget has left today.');
  }
  if ('refused' in out) return refusal(out.refused);
  return {
    content: [{ type: 'text' as const, text: out.summary }],
    structuredContent: out,
    isError: out.status === 'reverted',
  };
}

async function receiptOf(bridge: SessionBridge, callsId: Hex): Promise<z.infer<typeof output>> {
  for (const until = Date.now() + RECEIPT_MS; Date.now() < until; ) {
    const status = (await bridge.request('wallet_getCallsStatus', callsId).catch(() => undefined)) as
      | { status: number; receipts?: { transactionHash: Hex }[] }
      | undefined;
    const txHash = status?.receipts?.[0]?.transactionHash ?? null;
    if (status?.status === 200 && txHash) return { callsId, txHash, status: 'landed', summary: `Sent in ${txHash}.` };
    if (status && status.status >= 400) {
      return { callsId, txHash, status: 'reverted', summary: 'Reverted on chain. Nothing was sent.' };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return {
    callsId,
    txHash: null,
    status: 'unconfirmed',
    summary: `Submitted as ${callsId} and not confirmed yet. Check it before sending again, or it may land twice.`,
  };
}

const logFailure = (msg: string) => (err: unknown) => log('error', { msg, error: errorLabel(err) });

function concludeSend(id: string, out: z.infer<typeof output>) {
  if (out.status === 'landed') return settleSend(id, { state: 'landed', txHash: out.txHash as Hex });
  if (out.status === 'reverted') return settleSend(id, { state: 'released' });
  return handToReconciler(id);
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
