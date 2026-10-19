import { createHash, randomBytes } from 'node:crypto';
import type { SessionBridge } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { and, eq } from 'drizzle-orm';
import { getAddress, isAddress, numberToHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { chainClients, sessionBridge } from '@/adapters/session-host';
import { tenant, type Tenant } from '@/connections/auth';
import { isLive } from '@/connections/rows';
import { spends } from '@/connections/scopes';
import type { Tx } from '@/db/client';
import { connections } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { ChainUnreadable, fit, spendOf, type Call, type Refusal } from '@/grants/fit';
import { lostInTransit, refusalOfFailure, refusalOfLogs } from '@/grants/reverts';
import { unrevokedGrant, type LiveGrant } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { FloatBusy, FloatLost, inTurn, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import {
  handToReconciler,
  noteCallsId,
  openSpends,
  recordSend,
  runOf,
  settleSends,
  type SendRow,
} from '@/payments/sends';
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
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,100}$/)
    .optional()
    .describe('Reuse it to retry this exact execute; one is made up and returned when absent'),
});
export type ExecuteInput = z.input<typeof executeInput>;

const output = z.object({
  status: z.enum(['landed', 'reverted', 'unconfirmed']),
  idempotencyKey: z.string(),
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
const maybeSent = (key: string) =>
  `This execute failed and may have been sent anyway. Send idempotencyKey ${key} again with the same calls: it returns this answer and never sends twice. ` +
  'Check jaw_session_history before sending it under a new key, or it may land twice.';
const NO_HASH =
  'This key ran without a userOp hash on record: nothing was sent, or the answer was lost and it was not seen on chain in time. ' +
  "Its spend is no longer held. Check the account's balances before sending it under a new idempotencyKey.";
const notSeen = (userOpHash: string) =>
  `userOp ${userOpHash} was not seen on chain in time, so its spend is no longer held; it may still land. ` +
  "Check the account's balances before sending it under a new idempotencyKey.";

type CallStatus = {
  status: number;
  receipts?: { transactionHash: Hex; logs?: { data: Hex; topics: Hex[] }[] }[];
};

const landed = (idempotencyKey: string, userOpHash: string, txHash: string): Outcome => ({
  status: 'landed',
  idempotencyKey,
  userOpHash,
  txHash,
  summary: `Landed in ${txHash}.`,
});
const reverted = (idempotencyKey: string, userOpHash: string, txHash: string | null): Outcome => ({
  status: 'reverted',
  idempotencyKey,
  userOpHash,
  txHash,
  summary: `userOp ${userOpHash} did not succeed on chain; its calls moved nothing.`,
});
const unconfirmed = (idempotencyKey: string, userOpHash: string): Outcome => ({
  status: 'unconfirmed',
  idempotencyKey,
  userOpHash,
  txHash: null,
  summary: `Submitted as userOp ${userOpHash} and not confirmed yet. jaw_session_history shows when it lands; the same idempotencyKey returns this run and never sends twice.`,
});

const answered = (out: Outcome) => ({ ...reply(out), isError: out.status === 'reverted' });

async function receiptOf(
  bridge: SessionBridge,
  key: string,
  userOpHash: Hex
): Promise<{ out: Outcome; refused?: Refusal }> {
  for (const until = Date.now() + RECEIPT_MS; Date.now() < until; ) {
    const status = (await bridge.request('wallet_getCallsStatus', userOpHash).catch(() => undefined)) as
      | CallStatus
      | undefined;
    const txHash = status?.receipts?.[0]?.transactionHash ?? null;
    if (status?.status === 200 && txHash) return { out: landed(key, userOpHash, txHash) };
    // 400 is a failure off chain with no receipt, which says nothing about inclusion.
    if (status && status.status >= 500) {
      const logs = (status.receipts ?? []).flatMap((r) => r.logs ?? []);
      return { out: reverted(key, userOpHash, txHash), refused: refusalOfLogs(logs) };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { out: unconfirmed(key, userOpHash) };
}

function replayed(rows: SendRow[], key: string, hash: string): ToolResult | ReturnType<typeof answered> {
  if (rows[0].requestHash !== hash) {
    return refusal(`idempotency_conflict: idempotencyKey ${key} was used for another execute.${NOTHING_SENT}`);
  }
  const done = rows.find((r) => r.state === 'landed');
  if (done) return answered(landed(key, done.callsId as string, done.txHash as string));
  const { state, callsId, txHash } = rows.find((r) => r.state === 'open') ?? rows[0];
  if (state === 'open') return callsId ? answered(unconfirmed(key, callsId)) : refusal(maybeSent(key));
  if (!callsId) return refusal(NO_HASH);
  return txHash ? answered(reverted(key, callsId, txHash)) : refusal(notSeen(callsId));
}

const logFailure = (msg: string) => (err: unknown) => log('error', { msg, error: errorLabel(err) });

function concluded(ids: string[], out: Outcome) {
  const callsId = out.userOpHash as Hex;
  if (out.status === 'landed') return settleSends(ids, { state: 'landed', txHash: out.txHash as Hex, callsId });
  if (out.status === 'reverted') return settleSends(ids, { state: 'released', txHash: out.txHash as Hex | null });
  return handToReconciler(ids, undefined, callsId);
}

// `lost`: the request may have reached the bundler and only its answer was lost.
type Submitted = { sent: Hex } | { unsent: unknown } | { lost: unknown };

function noteSubmitted(tx: Tx, ids: string[], submitted: Submitted) {
  if ('sent' in submitted) return noteCallsId(tx, ids, submitted.sent);
  if ('lost' in submitted) return handToReconciler(ids, tx);
  return settleSends(ids, { state: 'released' }, tx);
}

interface Run {
  key: string;
  hash: string;
  permissionId: string;
  chainId: number;
  calls: Call[];
}

async function grantFor(t: Tenant, run: Run): Promise<ToolResult | { grant: LiveGrant; bridge: SessionBridge }> {
  const grant = await unrevokedGrant(t.connectionId, run.permissionId);
  if (!grant || grant.chainId !== run.chainId) {
    return refusal(described({ reason: 'no-grant' }, run.permissionId) + NOTHING_SENT);
  }
  if (grant.kind === 'x402-budget') {
    return refusal(
      `no-grant: ${run.permissionId} is this connection's x402 budget, which pays x402 services only. Execute under a custom grant from jaw_grant_permissions.${NOTHING_SENT}`
    );
  }
  const bridge = sessionBridge(t, grant);
  if (!bridge) return refusal('This server has no paymaster key, so it cannot pay the fee to send.');
  return { grant, bridge };
}

type Reserved = { ids: string[]; submitted: Submitted; bridge: SessionBridge };

async function submitUnder(t: Tenant, run: Run): Promise<ToolResult | Reserved> {
  return withFloat(t.connectionId, LOCK_WAIT_MS, async (hold) => {
    const stored = await hold.tx(async (tx) => {
      if (!(await hold.owns(tx))) throw new FloatLost();
      const rows = await runOf(tx, t.connectionId, run.key);
      const [live] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(eq(connections.id, t.connectionId), isLive()));
      return { rows, live: Boolean(live) };
    });
    if (stored.rows.length > 0) return replayed(stored.rows, run.key, run.hash);
    if (!stored.live) return refusal('This connection has ended, so nothing was sent.');
    const found = await grantFor(t, run);
    if (!('grant' in found)) return found;
    const { grant, bridge } = found;
    const pending = await hold.tx((tx) => openSpends(grant.permissionId, tx));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const refused = await fit(grant, run.calls, { read: { clients: chainClients }, pending, nowSeconds });
    if (refused) return refusal(described(refused, grant.permissionId) + NOTHING_SENT);
    const head = await chainClients
      .publicClient(grant.chainId)
      .getBlockNumber()
      .catch(() => undefined);
    if (head === undefined) return refusal(UNREADABLE);

    const spent = [...spendOf(run.calls, grant.account)];
    const ids = await hold.tx(async (tx) => {
      if (!(await hold.owns(tx))) throw new FloatLost();
      const send = {
        connectionId: t.connectionId,
        idempotencyKey: run.key,
        requestHash: run.hash,
        permissionId: grant.permissionId,
        chainId: grant.chainId,
        sender: t.sessionAddress,
        periodStart: nowSeconds,
        fromBlock: head,
      };
      if (spent.length === 0) return [await recordSend(tx, { ...send, token: null, amount: 0n })];
      return Promise.all(spent.map(([token, amount]) => recordSend(tx, { ...send, token: token as Address, amount })));
    });
    let submitted: Submitted;
    try {
      hold.assertHeld();
      const wire = run.calls.map((c) => ({ to: c.to, value: numberToHex(c.value), data: c.data }));
      const sent = (await bridge.request('wallet_sendCalls', [{ calls: wire }])) as { id: Hex };
      submitted = { sent: sent.id };
    } catch (err) {
      submitted = lostInTransit(err) ? { lost: err } : { unsent: err };
    }
    await hold.tx((tx) => noteSubmitted(tx, ids, submitted)).catch(logFailure('execute submit write failed'));
    return { ids, submitted, bridge };
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

async function executeUnder(t: Tenant, run: Run) {
  const reserved = await inTurn(t.connectionId, () => submitUnder(t, run));
  if (!('submitted' in reserved)) return reserved;
  const { ids, submitted, bridge } = reserved;
  if ('unsent' in submitted) return unsentReply(submitted.unsent, run.permissionId);
  if ('lost' in submitted) {
    log('warn', { msg: 'execute may have been submitted', error: errorLabel(submitted.lost) });
    return refusal(maybeSent(run.key));
  }
  const { out, refused } = await receiptOf(bridge, run.key, submitted.sent);
  await concluded(ids, out).catch(logFailure('execute conclusion write failed'));
  if (refused) return refusal(`${described(refused, run.permissionId)} ${out.summary}`);
  return answered(out);
}

export async function sessionExecute(t: Tenant, input: ExecuteInput) {
  if (!spends(t.scopes)) return refusal(NO_PAY_SCOPE);
  if (await isPaymentsPaused()) return refusal('Payments are paused on this server, so nothing was sent.');
  const chainId = input.chainId ?? t.chainId;
  const calls: Call[] = input.calls.map((c) => ({
    to: getAddress(c.to),
    value: BigInt(c.value ?? '0'),
    data: (c.data ?? '0x').toLowerCase() as Hex,
  }));
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        chainId,
        input.permissionId.toLowerCase(),
        calls.map((c) => [c.to.toLowerCase(), c.value.toString(), c.data]),
      ])
    )
    .digest('hex');
  const key = input.idempotencyKey ?? `auto_${randomBytes(12).toString('base64url')}`;
  try {
    return await executeUnder(t, { key, hash, permissionId: input.permissionId, chainId, calls });
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
        "The x402 budget pays x402 services only and is refused here. The fee comes from the session key's own USDC, which the x402 budget funds. " +
        'Send the same idempotencyKey and calls to retry: a retry returns the first run and never sends twice.',
      inputSchema: executeInput,
      outputSchema: output,
    },
    async (input, ctx) => sessionExecute(tenant(ctx), input)
  );
}
