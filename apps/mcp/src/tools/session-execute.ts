import type { SessionBridge } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import { getAddress, isAddress, numberToHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { chainClients, sessionBridge } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { isLive } from '@/connections/rows';
import { spends } from '@/connections/scopes';
import { connections } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { ChainUnreadable, fit, spendOf, type Call, type Refusal } from '@/grants/fit';
import { lostInTransit, refusalOfFailure, refusalOfLogs } from '@/grants/reverts';
import { unrevokedGrant, type LiveGrant } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { FloatBusy, FloatLost, inTurn, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import { handToReconciler, noteCallsId, openSpends, recordSend, settleSend } from '@/payments/sends';
import { NO_PAY_SCOPE, refusal } from './reply';

const MAX_CALLS = 10;
export const RECEIPT_MS = 60_000;

const executeInput = z.strictObject({
  permissionId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('The custom grant to act under, one jaw_grant_permissions recorded on this connection'),
  chainId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The chain the grant is on; defaults to this connection's chain"),
  calls: z
    .array(
      z.strictObject({
        to: z.string().refine((a) => isAddress(a, { strict: false }), 'must be a 0x address'),
        value: z
          .string()
          .regex(/^\d{1,78}$/)
          .optional()
          .describe("Wei of the chain's own coin, as a decimal integer"),
        data: z
          .string()
          .regex(/^0x([0-9a-fA-F]{2})*$/)
          .max(65_538)
          .optional()
          .describe('The calldata, 0x-prefixed hex'),
      })
    )
    .min(1)
    .max(MAX_CALLS),
});
export type ExecuteInput = z.input<typeof executeInput>;

const output = z.object({
  status: z.enum(['landed', 'reverted', 'unconfirmed']),
  userOpHash: z.string(),
  txHash: z.string().nullable(),
  summary: z.string(),
});
type Outcome = z.infer<typeof output>;
type ToolResult = ReturnType<typeof refusal>;

function described(r: Refusal, permissionId: string): string {
  switch (r.reason) {
    case 'call-not-allowed':
      return `call-not-allowed: grant ${permissionId} does not allow calling ${r.selector} on ${r.target}.`;
    case 'over-limit':
      return 'onChain' in r
        ? `over-limit: the permission manager refused the batch for spending past, or without, a spend limit of grant ${permissionId}.`
        : `over-limit: the batch moves ${r.spend} base units of ${r.token}, and grant ${permissionId} has ${r.left} left this period.`;
    case 'expired':
      return `expired: grant ${permissionId} is outside its time window. Ask the owner for a new one with jaw_grant_permissions.`;
    case 'no-grant':
      return `no-grant: this connection holds no live custom grant ${permissionId}. jaw_connections lists the ones it holds.`;
  }
}

const NOTHING_SENT = ' Nothing was sent.';
const UNREADABLE = 'Nothing was sent: the grant could not be read from the chain right now. Try again in a moment.';
const MAYBE_SENT =
  'This execute failed and may have been sent anyway. Check jaw_session_history before sending again, or it may land twice.';

type CallStatus = {
  status: number;
  receipts?: { transactionHash: Hex; logs?: { data: Hex; topics: Hex[] }[] }[];
};

async function receiptOf(bridge: SessionBridge, userOpHash: Hex): Promise<{ out: Outcome; refused?: Refusal }> {
  for (const until = Date.now() + RECEIPT_MS; Date.now() < until; ) {
    const status = (await bridge.request('wallet_getCallsStatus', userOpHash).catch(() => undefined)) as
      | CallStatus
      | undefined;
    const txHash = status?.receipts?.[0]?.transactionHash ?? null;
    if (status?.status === 200 && txHash) {
      return { out: { status: 'landed', userOpHash, txHash, summary: `Landed in ${txHash}.` } };
    }
    // 400 is a failure off chain with no receipt, which says nothing about inclusion.
    if (status && status.status >= 500) {
      const logs = (status.receipts ?? []).flatMap((r) => r.logs ?? []);
      const summary = `userOp ${userOpHash} did not succeed on chain; its calls moved nothing.`;
      return { out: { status: 'reverted', userOpHash, txHash, summary }, refused: refusalOfLogs(logs) };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const summary = `Submitted as userOp ${userOpHash} and not confirmed yet. jaw_session_history shows when it lands; check it before sending again, or it may land twice.`;
  return { out: { status: 'unconfirmed', userOpHash, txHash: null, summary } };
}

const logFailure = (msg: string) => (err: unknown) => log('error', { msg, error: errorLabel(err) });

const release = (ids: string[]) => Promise.all(ids.map((id) => settleSend(id, { state: 'released' })));

function concluded(ids: string[], out: Outcome) {
  if (out.status === 'landed') {
    return Promise.all(ids.map((id) => settleSend(id, { state: 'landed', txHash: out.txHash as Hex })));
  }
  if (out.status === 'reverted') return release(ids);
  return handToReconciler(ids);
}

// `lost`: the request may have reached the bundler and only its answer was lost.
type Submitted = { sent: Hex } | { unsent: unknown } | { lost: unknown };

async function submitUnder(
  t: Tenant,
  grant: LiveGrant,
  calls: Call[],
  bridge: SessionBridge
): Promise<ToolResult | { ids: string[]; submitted: Submitted }> {
  return withFloat(t.connectionId, LOCK_WAIT_MS, async (hold) => {
    const live = await hold.tx(async (tx) => {
      if (!(await hold.owns(tx))) throw new FloatLost();
      const [row] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, t.connectionId), isLive()));
      return Boolean(row);
    });
    if (!live) return refusal('This connection has ended, so nothing was sent.');
    const pending = await hold.tx((tx) => openSpends(grant.permissionId, tx));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const refused = await fit(grant, calls, { read: { clients: chainClients }, pending, nowSeconds });
    if (refused) return refusal(described(refused, grant.permissionId) + NOTHING_SENT);
    const head = await chainClients
      .publicClient(grant.chainId)
      .getBlockNumber()
      .catch(() => undefined);
    if (head === undefined) return refusal(UNREADABLE);

    const spent = [...spendOf(calls, grant.account)];
    const ids = await hold.tx(async (tx) => {
      if (!(await hold.owns(tx))) throw new FloatLost();
      const row = { connectionId: t.connectionId, permissionId: grant.permissionId, chainId: grant.chainId };
      const send = { ...row, sender: t.sessionAddress, periodStart: nowSeconds, fromBlock: head };
      if (spent.length === 0) return [await recordSend(tx, { ...send, token: null, amount: 0n })];
      return Promise.all(spent.map(([token, amount]) => recordSend(tx, { ...send, token: token as Address, amount })));
    });
    try {
      hold.assertHeld();
      const wire = calls.map((c) => ({ to: c.to, value: numberToHex(c.value), data: c.data }));
      const sent = (await bridge.request('wallet_sendCalls', [{ calls: wire }])) as { id: Hex };
      return { ids, submitted: { sent: sent.id } };
    } catch (err) {
      return { ids, submitted: lostInTransit(err) ? { lost: err } : { unsent: err } };
    }
  });
}

function unsentReply(err: unknown, permissionId: string): ToolResult {
  const named = refusalOfFailure(err);
  if (named) return refusal(described(named, permissionId) + NOTHING_SENT);
  if (err instanceof FloatLost) return refusal('Nothing was sent: this execute lost its turn on the float. Try again.');
  log('warn', { msg: 'execute not submitted', error: errorLabel(err) });
  return refusal(
    `Nothing was sent: the batch failed in simulation or the bundler refused it (${errorLabel(err)}). ` +
      'Usually a call reverts, or the session key holds no USDC for its fee, which an x402 budget from jaw_grant_permissions funds.'
  );
}

/**
 * The float lock is held while the batch is checked, recorded and submitted, not while
 * its receipt is awaited: a later run counts this one's open rows until they settle.
 */
async function executeUnder(t: Tenant, grant: LiveGrant, calls: Call[], bridge: SessionBridge) {
  const reserved = await inTurn(t.connectionId, () => submitUnder(t, grant, calls, bridge));
  if (!('submitted' in reserved)) return reserved;
  const { ids, submitted } = reserved;
  if ('unsent' in submitted) {
    await release(ids).catch(logFailure('execute conclusion write failed'));
    return unsentReply(submitted.unsent, grant.permissionId);
  }
  if ('lost' in submitted) {
    await handToReconciler(ids).catch(logFailure('execute conclusion write failed'));
    log('warn', { msg: 'execute may have been submitted', error: errorLabel(submitted.lost) });
    return refusal(MAYBE_SENT);
  }
  await noteCallsId(ids, submitted.sent).catch(logFailure('execute userOp hash write failed'));
  const { out, refused } = await receiptOf(bridge, submitted.sent);
  await concluded(ids, out).catch(logFailure('execute conclusion write failed'));
  if (refused) return refusal(`${described(refused, grant.permissionId)} ${out.summary}`);
  return { ...reply(out), isError: out.status === 'reverted' };
}

export async function sessionExecute(t: Tenant, input: ExecuteInput) {
  if (!spends(t.scopes)) return refusal(NO_PAY_SCOPE);
  if (await isPaymentsPaused()) return refusal('Payments are paused on this server, so nothing was sent.');
  const chainId = input.chainId ?? t.chainId;
  const grant = await unrevokedGrant(t.connectionId, input.permissionId);
  if (!grant || grant.chainId !== chainId) {
    return refusal(described({ reason: 'no-grant' }, input.permissionId) + NOTHING_SENT);
  }
  if (grant.kind === 'x402-budget') {
    return refusal(
      `no-grant: ${input.permissionId} is this connection's x402 budget, which pays x402 services only. Execute under a custom grant from jaw_grant_permissions.${NOTHING_SENT}`
    );
  }
  const bridge = sessionBridge(t, grant);
  if (!bridge) return refusal('This server has no paymaster key, so it cannot pay the fee to send.');
  const calls: Call[] = input.calls.map((c) => ({
    to: getAddress(c.to),
    value: BigInt(c.value ?? '0'),
    data: (c.data ?? '0x') as Hex,
  }));
  try {
    return await executeUnder(t, grant, calls, bridge);
  } catch (err) {
    if (err instanceof ChainUnreadable) return refusal(UNREADABLE);
    if (err instanceof FloatBusy) return refusal('A payment on this connection is in progress. Try again in a moment.');
    return unsentReply(err, input.permissionId);
  }
}

export function registerSessionExecuteTool(server: McpServer) {
  server.registerTool(
    'jaw_session_execute',
    {
      description:
        'Send up to 10 contract calls as the session key, under a custom grant the owner approved with jaw_grant_permissions. No prompt to the owner: the grant is the limit. ' +
        'Before any userOp it checks every call against the grant and what each spend limit has left, and refuses by name: call-not-allowed, over-limit, expired or no-grant. ' +
        "The x402 budget pays x402 services only and is refused here. The fee comes from the session key's own USDC, which the x402 budget funds.",
      inputSchema: executeInput,
      outputSchema: output,
    },
    async (input, ctx) => sessionExecute(tenant(ctx), input)
  );
}
