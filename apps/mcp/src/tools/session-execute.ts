import { createHash, randomBytes } from 'node:crypto';
import { within, type SessionBridge } from '@jaw.id/agent';
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
import { ChainUnreadable, fit, namesEveryTarget, spendOf, type Call, type Refusal } from '@/grants/fit';
import { mayHaveBeenSent, refusalOfFailure, refusalOfLogs } from '@/grants/reverts';
import { unrevokedGrant, type LiveGrant } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { FloatBusy, FloatLost, inTurn, LOCK_WAIT_MS, withFloat } from '@/payments/float-lock';
import { EXECUTE_SUBMIT_MS } from '@/payments/store';
import {
  handToReconciler,
  noteCallsId,
  recordSend,
  chainView,
  heldSpends,
  LOGGED_READ_MS,
  readAt,
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
const maybeSent = (key: string, userOpHash?: Hex) =>
  (userOpHash
    ? `This execute failed and may have been sent anyway as userOp ${userOpHash}. Send idempotencyKey ${key} again with the same calls to follow it: it never sends twice. `
    : `This execute failed and may have been sent anyway. Send idempotencyKey ${key} again with the same calls: it returns this answer and never sends twice. `) +
  'Check jaw_session_history before sending it under a new key, or it may land twice.';
const NOTHING_WENT_OUT = "This key's run sent nothing. Send it again under a new idempotencyKey.";
const notSeen = (userOpHash: string) =>
  `userOp ${userOpHash} was not seen on chain in time, so its spend is no longer held; it may still land. ` +
  "Check the account's balances before sending it under a new idempotencyKey.";

type CallStatus = {
  status: number;
  receipts?: { transactionHash: Hex; logs?: { address: Address; data: Hex; topics: Hex[] }[] }[];
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
  summary: `userOp ${userOpHash} is signed and not confirmed on chain yet. jaw_session_history shows when it lands; the same idempotencyKey returns this run and never sends twice.`,
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
      return { out: reverted(key, userOpHash, txHash), refused: refusalOfLogs(logs, userOpHash) };
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
  if (!callsId) return refusal(NOTHING_WENT_OUT);
  if (state === 'open') return answered(unconfirmed(key, callsId));
  return txHash ? answered(reverted(key, callsId, txHash)) : refusal(notSeen(callsId));
}

const logFailure = (msg: string) => (err: unknown) => log('error', { msg, error: errorLabel(err) });

function concluded(ids: string[], out: Outcome) {
  const callsId = out.userOpHash as Hex;
  if (out.status === 'landed') return settleSends(ids, { state: 'landed', txHash: out.txHash as Hex, callsId });
  if (out.status === 'reverted')
    return settleSends(ids, { state: 'released', txHash: out.txHash as Hex | null, callsId });
  return handToReconciler(ids, undefined, callsId);
}

type Submitted = { sent: Hex } | { unsent: unknown } | { maybe: unknown; userOpHash?: Hex };

async function noteSubmitted(tx: Tx, ids: string[], submitted: Submitted): Promise<void> {
  if ('sent' in submitted) {
    await noteCallsId(tx, ids, submitted.sent);
    return;
  }
  if ('maybe' in submitted) return handToReconciler(ids, tx);
  // A hash on a released row reads as "may still land" on replay.
  return settleSends(ids, { state: 'released', callsId: null }, tx);
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

const ENDED = 'This connection has ended, so nothing was sent.';

// Half the window an end waits on a recorded execute, so a submit still running is
// answered as maybe sent well before an end may pass it.
const SUBMIT_MS = EXECUTE_SUBMIT_MS / 2;
class SubmitTimedOut extends Error {}

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubmitTimedOut()), SUBMIT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function liveIn(tx: Tx, connectionId: string): Promise<boolean> {
  const [live] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.id, connectionId), isLive()));
  return live !== undefined;
}

type Reserved = { ids: string[]; submitted: Submitted; bridge: SessionBridge; trustsReverts: boolean };

async function submitUnder(t: Tenant, run: Run): Promise<ToolResult | Reserved> {
  return withFloat(t.connectionId, LOCK_WAIT_MS, async (hold) => {
    // A run left unconfirmed may have landed since. Settled first, its key replays it landed
    // and the next fit counts its spend on chain only. A read past its bound settles nothing.
    const view = await within(
      chainView(t.connectionId, run.permissionId, run.chainId, chainClients),
      LOGGED_READ_MS
    ).catch((err: unknown) => void logFailure('execute settle read failed')(err));
    for (const { id, end } of view?.ends ?? []) {
      await settleSends([id], end).catch(logFailure('execute settle write failed'));
    }
    const stored = await hold.tx(async (tx) => {
      if (!(await hold.owns(tx))) throw new FloatLost();
      return { rows: await runOf(tx, t.connectionId, run.key), live: await liveIn(tx, t.connectionId) };
    });
    if (stored.rows.length > 0) return replayed(stored.rows, run.key, run.hash);
    if (!stored.live) return refusal(ENDED);
    const found = await grantFor(t, run);
    if (!('grant' in found)) return found;
    const { grant, bridge } = found;
    const pending = await hold.tx((tx) => heldSpends(grant.permissionId, tx, view?.seen));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const refused = await fit(grant, run.calls, {
      read: readAt(chainClients, grant.chainId, view?.head),
      pending,
      nowSeconds,
    });
    if (refused) return refusal(described(refused, grant.permissionId) + NOTHING_SENT);
    const head = await chainClients
      .publicClient(grant.chainId)
      .getBlockNumber()
      .catch(() => undefined);
    if (head === undefined) return refusal(UNREADABLE);

    const spent = [...spendOf(run.calls, grant.account)];
    // owns() holds the connection row, so an end waits on this tx and then sees the rows in flight.
    const ids = await hold.tx(async (tx) => {
      if (!(await hold.owns(tx))) throw new FloatLost();
      if (!(await liveIn(tx, t.connectionId))) return undefined;
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
    if (!ids) return refusal(ENDED);
    let submitted: Submitted;
    let request: Promise<{ id: Hex }> | undefined;
    const recorded: { userOpHash?: Hex } = {};
    // Set synchronously, so a submit past its bound either started signing or never will.
    let signing = false;
    let abandoned = false;
    try {
      hold.assertHeld();
      const wire = run.calls.map((c) => ({ to: c.to, value: numberToHex(c.value), data: c.data }));
      request = bridge.request('wallet_sendCalls', [{ calls: wire }], async (userOpHash) => {
        if (abandoned) throw new SubmitTimedOut();
        signing = true;
        await hold.tx(async (tx) => {
          if (!(await hold.owns(tx))) throw new FloatLost();
          if ((await noteCallsId(tx, ids, userOpHash)) !== ids.length) throw new Error('the run rows were settled');
        });
        recorded.userOpHash = userOpHash;
      }) as Promise<{ id: Hex }>;
      const sent = await bounded(request);
      if (sent.id !== recorded.userOpHash) {
        log('error', { msg: `bundler returned another userOp hash than ${recorded.userOpHash}`, callsId: sent.id });
      }
      submitted = { sent: sent.id };
    } catch (err) {
      // A submit past its bound that has not started signing never will: its hook throws first.
      if (err instanceof SubmitTimedOut && !signing) abandoned = true;
      const maybe = err instanceof SubmitTimedOut ? signing : Boolean(recorded.userOpHash) && mayHaveBeenSent(err);
      submitted = maybe ? { maybe: err, userOpHash: recorded.userOpHash } : { unsent: err };
      // A submit that answers past its bound leaves its hash on the open rows for the reconciler.
      if (err instanceof SubmitTimedOut) {
        request?.then(
          (late) => handToReconciler(ids, undefined, late.id).catch(logFailure('execute late submit write failed')),
          () => {}
        );
      }
    }
    await hold.tx((tx) => noteSubmitted(tx, ids, submitted)).catch(logFailure('execute submit write failed'));
    return { ids, submitted, bridge, trustsReverts: namesEveryTarget(grant, run.calls) };
  });
}

function unsentReply(err: unknown, permissionId: string, trustsReverts: boolean): ToolResult {
  const refused = trustsReverts ? refusalOfFailure(err) : undefined;
  if (refused) return refusal(described(refused, permissionId) + NOTHING_SENT);
  if (err instanceof FloatLost || err instanceof FloatBusy)
    return refusal('Nothing was sent: this execute lost its turn on the float. Try again.');
  log('warn', { msg: 'execute not submitted', error: errorLabel(err) });
  return refusal(
    `Nothing was sent: the batch failed in simulation or before it reached the bundler (${errorLabel(err)}). ` +
      'Usually a call reverts, or the session key holds no USDC for its fee, which an x402 budget from jaw_grant_permissions funds.'
  );
}

async function executeUnder(t: Tenant, run: Run) {
  const reserved = await inTurn(t.connectionId, () => submitUnder(t, run));
  if (!('submitted' in reserved)) return reserved;
  const { ids, submitted, bridge, trustsReverts } = reserved;
  if ('unsent' in submitted) return unsentReply(submitted.unsent, run.permissionId, trustsReverts);
  if ('maybe' in submitted) {
    log('warn', { msg: 'execute may have been submitted', error: errorLabel(submitted.maybe) });
    return refusal(maybeSent(run.key, submitted.userOpHash));
  }
  const { out, refused } = await receiptOf(bridge, run.key, submitted.sent);
  await concluded(ids, out).catch(logFailure('execute conclusion write failed'));
  if (refused && trustsReverts) return refusal(`${described(refused, run.permissionId)} ${out.summary}`);
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
    return unsentReply(err, input.permissionId, false);
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
