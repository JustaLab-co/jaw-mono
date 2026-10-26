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
import { chainName, receiptLine, tokenAmount } from '@/lib/owner-text';
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
import { NO_PAY_SCOPE, refusal, withNext } from './reply';

const MAX_CALLS = 10;
export const RECEIPT_MS = 60_000;

const executeInput = z.strictObject({
  permissionId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('The custom permission to act under, one jaw_grant_permissions recorded on this connection'),
  chainId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The chain the permission is on; defaults to this connection's chain"),
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

/** A refused run: what the owner hears, after its code, and how the agent routes it back to the owner. */
interface Said {
  say: string;
  next: string;
}

const ONE_OFF = 'offer to do it once for their approval with jaw_send_calls';

function described(r: Refusal, permissionId: string, chainId: number): Said {
  switch (r.reason) {
    case 'call-not-allowed':
      return {
        say: `call-not-allowed: The permission does not allow this action on ${r.target}.`,
        next: `Tell the owner it is outside what they approved, and ${ONE_OFF}. Permission ${permissionId} does not allow calling ${r.selector} on ${r.target}.`,
      };
    case 'over-limit':
      return {
        say:
          'onChain' in r
            ? 'over-limit: The permission refused this: it would move more than a spend limit allows, or a token the permission sets no limit on.'
            : `over-limit: This would move ${tokenAmount(chainId, r.token, r.spend)}, and the permission has ${tokenAmount(chainId, r.token, r.left)} left this period.`,
        next: 'Offer to do it once with jaw_send_calls, or wait for the period to reset. Never ask for a wider permission to make it pass.',
      };
    case 'expired':
      return {
        say: 'expired: The permission has ended.',
        next: 'If the owner still wants this to run on its own, offer a new permission; otherwise do it once with jaw_send_calls.',
      };
    case 'no-grant':
      return {
        say: 'no-grant: No live permission with that id on this connection.',
        next: `jaw_connections lists the ones it holds. Permission ${permissionId} is not one of them.`,
      };
  }
}

const NOTHING_SENT = 'Nothing was sent.';
const refusedRun = ({ say, next }: Said) => refusal(withNext(`${say} ${NOTHING_SENT}`, next));
const UNREADABLE =
  'Nothing was sent: the permission could not be read from the chain right now. Try again in a moment.';
const maybeSent = (key: string, userOpHash?: Hex) =>
  withNext(
    'This run failed and may have been sent anyway, so it is not known yet whether anything moved.',
    (userOpHash
      ? `It was signed as userOp ${userOpHash}. Send idempotencyKey ${key} again with the same calls to follow it: it never sends twice. `
      : `Send idempotencyKey ${key} again with the same calls: it returns this answer and never sends twice. `) +
      'Check jaw_session_history before sending it under a new key, or it may land twice.'
  );
const NOTHING_WENT_OUT = withNext('This run sent nothing.', 'Send it again under a new idempotencyKey.');
const notSeen = (userOpHash: string) =>
  withNext(
    "This run was not seen on chain in time, so it may still land. Check the wallet's balances before running it again.",
    `userOp ${userOpHash} is no longer held against the spend limit. Check the account's balances before sending it under a new idempotencyKey, or it may land twice.`
  );

type CallStatus = {
  status: number;
  receipts?: { transactionHash: Hex; logs?: { address: Address; data: Hex; topics: Hex[] }[] }[];
};

const landed = (chainId: number, idempotencyKey: string, userOpHash: string, txHash: string): Outcome => ({
  status: 'landed',
  idempotencyKey,
  userOpHash,
  txHash,
  summary: `Done. It went through on ${chainName(chainId)}. ${receiptLine(chainId, txHash)}`,
});
/** What the owner hears of a run that reverted on chain, with its receipt when there is one. */
const failedOn = (chainId: number, txHash: string | null) =>
  `It failed on ${chainName(chainId)}: nothing moved.${txHash ? ` ${receiptLine(chainId, txHash)}` : ''}`;
const reverted = (chainId: number, idempotencyKey: string, userOpHash: string, txHash: string | null): Outcome => ({
  status: 'reverted',
  idempotencyKey,
  userOpHash,
  txHash,
  summary: withNext(
    failedOn(chainId, txHash),
    'Say what likely went wrong if you know. Simulate before running again.'
  ),
});
const unconfirmed = (chainId: number, idempotencyKey: string, userOpHash: string): Outcome => ({
  status: 'unconfirmed',
  idempotencyKey,
  userOpHash,
  txHash: null,
  summary: withNext(
    `Sent on ${chainName(chainId)}, not confirmed yet.`,
    'jaw_session_history shows when it lands; the same idempotencyKey returns this run and never sends twice.'
  ),
});

const answered = (out: Outcome) => ({ ...reply(out), isError: out.status === 'reverted' });

async function receiptOf(
  bridge: SessionBridge,
  chainId: number,
  key: string,
  userOpHash: Hex
): Promise<{ out: Outcome; refused?: Refusal }> {
  for (const until = Date.now() + RECEIPT_MS; Date.now() < until; ) {
    const status = (await bridge.request('wallet_getCallsStatus', userOpHash).catch(() => undefined)) as
      | CallStatus
      | undefined;
    const txHash = status?.receipts?.[0]?.transactionHash ?? null;
    if (status?.status === 200 && txHash) return { out: landed(chainId, key, userOpHash, txHash) };
    // 400 is a failure off chain with no receipt, which says nothing about inclusion.
    if (status && status.status >= 500) {
      const logs = (status.receipts ?? []).flatMap((r) => r.logs ?? []);
      return { out: reverted(chainId, key, userOpHash, txHash), refused: refusalOfLogs(logs, userOpHash) };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { out: unconfirmed(chainId, key, userOpHash) };
}

function replayed(rows: SendRow[], key: string, hash: string): ToolResult | ReturnType<typeof answered> {
  if (rows[0].requestHash !== hash) {
    return refusal(
      withNext(
        `idempotency_conflict: This retry does not match the run it repeats. ${NOTHING_SENT}`,
        `idempotencyKey ${key} was used for another execute. Use a new key for different calls.`
      )
    );
  }
  const done = rows.find((r) => r.state === 'landed');
  if (done) return answered(landed(done.chainId, key, done.callsId as string, done.txHash as string));
  const { state, callsId, txHash, chainId } = rows.find((r) => r.state === 'open') ?? rows[0];
  if (!callsId) return refusal(NOTHING_WENT_OUT);
  if (state === 'open') return answered(unconfirmed(chainId, key, callsId));
  return txHash ? answered(reverted(chainId, key, callsId, txHash)) : refusal(notSeen(callsId));
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
    return refusedRun(described({ reason: 'no-grant' }, run.permissionId, run.chainId));
  }
  if (grant.kind === 'x402-budget') {
    return refusedRun({
      say: 'no-grant: That is the spend limit for paid services, which pays for services and fees and runs no actions.',
      next: `${run.permissionId} is this connection's x402 budget. Pass the permissionId of a custom permission (jaw_connections lists them), or ${ONE_OFF}.`,
    });
  }
  const bridge = sessionBridge(t, grant);
  if (!bridge) {
    return refusal(
      withNext(
        'This service cannot pay network fees right now, so nothing was sent.',
        'This server has no paymaster key, so it cannot pay the fee to send.'
      )
    );
  }
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
    if (refused) return refusedRun(described(refused, grant.permissionId, grant.chainId));
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

function unsentReply(err: unknown, run: Pick<Run, 'permissionId' | 'chainId'>, trustsReverts: boolean): ToolResult {
  const refused = trustsReverts ? refusalOfFailure(err) : undefined;
  if (refused) return refusedRun(described(refused, run.permissionId, run.chainId));
  if (err instanceof FloatLost || err instanceof FloatBusy) {
    return refusal(
      withNext(
        'Nothing was sent: another payment on this connection took its turn. Try again.',
        'This execute lost its turn on the float.'
      )
    );
  }
  log('warn', { msg: 'execute not submitted', error: errorLabel(err) });
  return refusal(
    withNext(
      'Nothing was sent: the run did not pass its final check. Usually one of its actions fails, or the connection has no USDC to pay the network fee.',
      `It failed in simulation or before it reached the bundler (${errorLabel(err)}). ` +
        'Simulate it with jaw_simulate_calls, passing the permissionId, to see which. ' +
        'If it is the fee, a spend limit for paid services funds it; ask for one with jaw_grant_permissions. ' +
        `If an action fails, ${ONE_OFF}, and never ask for a wider permission to make it pass.`
    )
  );
}

async function executeUnder(t: Tenant, run: Run) {
  const reserved = await inTurn(t.connectionId, () => submitUnder(t, run));
  if (!('submitted' in reserved)) return reserved;
  const { ids, submitted, bridge, trustsReverts } = reserved;
  if ('unsent' in submitted) return unsentReply(submitted.unsent, run, trustsReverts);
  if ('maybe' in submitted) {
    log('warn', { msg: 'execute may have been submitted', error: errorLabel(submitted.maybe) });
    return refusal(maybeSent(run.key, submitted.userOpHash));
  }
  const { out, refused } = await receiptOf(bridge, run.chainId, run.key, submitted.sent);
  await concluded(ids, out).catch(logFailure('execute conclusion write failed'));
  if (refused && trustsReverts) {
    const { say, next } = described(refused, run.permissionId, run.chainId);
    return refusal(withNext(`${say} ${failedOn(run.chainId, out.txHash)}`, next));
  }
  return answered(out);
}

export async function sessionExecute(t: Tenant, input: ExecuteInput) {
  if (!spends(t.scopes)) return refusal(NO_PAY_SCOPE);
  if (await isPaymentsPaused()) return refusal('Payments are paused on this service, so nothing was sent.');
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
    if (err instanceof FloatBusy) {
      return refusal('A payment on this connection is in progress, so nothing was sent. Try again in a moment.');
    }
    return unsentReply(err, { permissionId: input.permissionId, chainId }, false);
  }
}

export function registerSessionExecuteTool(server: McpServer) {
  server.registerTool(
    'jaw_session_execute',
    {
      title: 'Run an action under a permission',
      description:
        'Run up to 10 contract calls from this connection under a custom permission the owner approved with jaw_grant_permissions, with no approval needed: the permission is the limit. ' +
        'Use it for the repeated or unattended runs the permission was approved for, and only within what the owner asked. ' +
        "Before sending, it checks each call against the permission's allowed actions and what each spend limit has left, and refuses by name: call-not-allowed, over-limit, expired or no-grant. " +
        'A refused run never falls back to asking the owner: tell them what was refused and offer to do it once with jaw_send_calls, and never ask for a wider permission to make it pass. ' +
        "The spend limit for paid services runs no actions and is refused here; it pays this run's network fee in USDC from the connection's balance, so with none the run cannot be sent. " +
        'Simulate first with jaw_simulate_calls, passing the permissionId. ' +
        'Send the same idempotencyKey and calls to retry: a retry returns the first run and never sends twice.',
      inputSchema: executeInput,
      outputSchema: output,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => sessionExecute(tenant(ctx), input)
  );
}
