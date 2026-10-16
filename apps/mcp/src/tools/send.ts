import { usdcForNetwork, type SessionBridge } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, getAddress, isAddress, parseUnits, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { chainClients, sessionBridge } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { isLive } from '@/connections/rows';
import { connections } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { currentGrant } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { dayLeft, readDaySpend } from '@/payments/day-spend';
import { FloatBusy, FloatLost, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import { handToReconciler, noteCallsId, recordedSends, recordSend, settleSend } from '@/payments/sends';
import { entriesFor } from '@/payments/store';
import { resolveName } from './read';
import { NO_SEND_SCOPE, refusal } from './reply';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
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

const UNREADABLE = 'Nothing was sent: the budget could not be read from the chain right now.';

const OVER_DAY =
  "Nothing was sent: this would pass what today's budget has left after payments and transfers. " +
  'Ask for a larger budget with jaw_request_budget.';

/**
 * Runs a USDC transfer of `amount` units from the account through this connection's
 * permission, signed by its session key. The permission manager checks the call and
 * the spend cap on chain; the float lock keeps a refill from reading the allowance
 * mid-send.
 */
async function sendWithinBudget(t: Tenant, call: Call, amount: bigint) {
  if (await isPaymentsPaused()) return refusal('Payments are paused on this server, so nothing was sent.');
  const grant = await currentGrant(t.connectionId);
  if (!grant) return refusal('This connection has no budget yet. Ask for one with jaw_request_budget.');
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
      if (amount > dayLeft(BigInt(grant.allowance), day)) return { refused: OVER_DAY };
      const sendId = await hold.tx(async (tx) => {
        if (!(await hold.owns(tx))) throw new FloatLost();
        return recordSend(tx, {
          connectionId: t.connectionId,
          permissionId: grant.permissionId,
          chainId: grant.chainId,
          sender: t.sessionAddress,
          amount,
          periodStart: day.periodStart,
          fromBlock: head,
        });
      });
      try {
        hold.assertHeld();
        submitting = true;
        const sent = (await bridge.request('wallet_sendCalls', [{ calls: [call] }])) as { id: Hex };
        await noteCallsId(sendId, sent.id).catch(logFailure('send calls id write failed'));
        const done = await receiptOf(bridge, sent.id);
        await concludeSend(sendId, done).catch(logFailure('send conclusion write failed'));
        return done;
      } catch (err) {
        const unsent = !submitting || refusedInSimulation(err);
        await (unsent ? settleSend(sendId, { state: 'released' }) : handToReconciler(sendId)).catch(
          logFailure('send conclusion write failed')
        );
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
    return refusal('Nothing was sent: the transfer failed in simulation, or is over what the budget has left today.');
  }
  if ('refused' in out) return refusal(out.refused);
  return { ...reply(out), isError: out.status === 'reverted' };
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
      return sendWithinBudget(t, { to: usdc.address, data }, units);
    }
  );
}
