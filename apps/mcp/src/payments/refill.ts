import {
  checkCaps,
  currentLimitUsageOnChain,
  usdcForNetwork,
  ensurePayerFunds,
  refusedInSimulation,
  sumSpentSince,
  topUpCeiling,
  type ChainClients,
  type Logger,
  type PayAndFetchOptions,
  type TopUpExecutor,
  type TopUpOutcome,
  type X402Policy,
} from '@jaw.id/agent';
import { and, eq, isNotNull } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, isAddressEqual, type Address, type Hex } from 'viem';
import { sessionOf } from '@/adapters/session-host';
import { isLive } from '@/connections/rows';
import type { Tx } from '@/db/client';
import { connections, grants } from '@/db/schema';
import type { Grant } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { nonceUsed } from './confirm';
import { dayLeft, pullRoom, readDaySpend } from './day-spend';
import { FloatBusy, FloatLost, inTurn, withFloat, type FloatHold } from './float-lock';
import { recordedSends } from './sends';
import {
  addTopUp,
  assertOwned,
  entriesFor,
  forgetBatch,
  holdingRows,
  pulledUnderOtherGrants,
  recordTopUp,
  reserve,
  writeTopUpAhead,
  type PaymentRow,
} from './store';

export type EnsureFunds = NonNullable<PayAndFetchOptions['ensureFunds']>;

/** Kept for the paid send when the refill takes its share of the time budget. */
export const SEND_RESERVE_MS = 20_000;
const MIN_REFILL_MS = 5_000;

interface RefillContext {
  rowId: string;
  token: string;
  connectionId: string;
  payer: Address;
  grant: Grant;
  policy: X402Policy;
  /** Absent without a paymaster key: the float is still reserved, a shortfall is refused. */
  executor: TopUpExecutor | undefined;
  floatTarget: bigint;
  clients: ChainClients;
  logger: Logger;
}

/**
 * What the other rows still hold. A signed authorization whose nonce the token
 * already consumed was taken out of the balance read alongside it, so it holds
 * nothing more; one the chain cannot answer about holds its ceiling.
 */
export async function stillHeld(
  rows: PaymentRow[],
  clients: ChainClients,
  blockNumber: bigint | undefined
): Promise<bigint> {
  const holds = await Promise.all(
    rows.map(async (row) => {
      if (row.state === 'pending') return BigInt(row.reserved as string);
      const token = usdcForNetwork(row.network as string);
      const attempt = { payer: row.payer as Address, nonce: row.nonce as Hex, scheme: row.scheme as string };
      const settled = token && (await nonceUsed(attempt, token, clients, blockNumber).catch(() => false));
      return settled ? 0n : BigInt(row.authorized as string);
    })
  );
  return holds.reduce((sum, held) => sum + held, 0n);
}

const noRefill: TopUpExecutor = {
  request: async () => {
    throw new Error('this server has no paymaster key, so it cannot refill the payer');
  },
};

function transferAmount(params: unknown): bigint {
  const [{ calls }] = params as [{ calls: { data: Hex }[] }];
  if (calls.length !== 1) throw new Error('a top-up sends one ERC-20 transfer');
  const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
  if (functionName !== 'transfer') throw new Error('a top-up sends one ERC-20 transfer');
  return args[1] as bigint;
}

const logFailure = (msg: string) => (err: unknown) => log('error', { msg, error: errorLabel(err) });

/**
 * Sends with the batch id on the row before the userOp goes out. `undo` runs only when it
 * provably did not go out: the id could not be written, or the bundler refused it in simulation.
 */
async function sendRecorded<T>(
  hold: FloatHold,
  send: (onSigned: (batchId: Hex) => Promise<void>) => Promise<T>,
  record: (tx: Tx, batchId: Hex) => Promise<void>,
  undo: (tx: Tx, batchId: Hex | undefined) => Promise<void>
): Promise<{ sent: T; signed: Hex | undefined }> {
  let recorded: Hex | undefined;
  let unwritten = false;
  try {
    const sent = await send(async (batchId) => {
      try {
        await hold.tx(async (tx) => {
          if (!(await hold.owns(tx))) throw new FloatLost();
          await record(tx, batchId);
        });
      } catch (err) {
        unwritten = true;
        throw err;
      }
      recorded = batchId;
    });
    return { sent, signed: recorded };
  } catch (err) {
    if (unwritten || (recorded && refusedInSimulation(err))) {
      await hold.tx((tx) => undo(tx, recorded)).catch(logFailure('unsent batch undo failed'));
    }
    throw err;
  }
}

/** The bundler's hash wins over the signed one, as it does for execute rows, and the mismatch is logged. */
async function keepSent(
  hold: FloatHold,
  rowId: string,
  field: 'topUpBatchId' | 'approvalBatchId',
  signed: Hex | undefined,
  sent: string
) {
  if (sent === signed) return;
  if (signed) log('error', { msg: `bundler returned another userOp hash than ${signed}`, callsId: sent });
  await hold
    .tx(async (tx) => {
      if (signed) await forgetBatch(tx, rowId, field, signed);
      const trace = field === 'topUpBatchId' ? { batchId: sent } : { approvalBatchId: sent };
      await recordTopUp(tx, rowId, { ok: true, ...trace });
    })
    .catch(logFailure('batch id write failed'));
}

function guarded(
  executor: TopUpExecutor,
  hold: FloatHold,
  rowId: string
): { executor: TopUpExecutor; failedBeforeSend: () => unknown } {
  const approve = executor.approvePermit2?.bind(executor);
  let failedBeforeSend: unknown;
  return {
    failedBeforeSend: () => failedBeforeSend,
    executor: {
      request: async (method, params) => {
        if (method !== 'wallet_sendCalls') return executor.request(method, params);
        let amount: bigint;
        try {
          amount = transferAmount(params);
          // A turn whose lock was taken while it went unnoticed sends nothing.
          await hold.tx(async (tx) => {
            if (!(await hold.owns(tx))) throw new FloatLost();
            await writeTopUpAhead(tx, rowId, amount);
          });
        } catch (err) {
          failedBeforeSend = err;
          throw err;
        }
        try {
          hold.assertHeld();
        } catch (err) {
          await hold.tx((tx) => addTopUp(tx, rowId, -amount)).catch(logFailure('top-up subtract failed'));
          throw err;
        }
        // A send that throws may still land, so the amount stays on the row, with its hash.
        const { sent, signed } = await sendRecorded(
          hold,
          (onSigned) => executor.request(method, params, onSigned),
          (tx, batchId) => recordTopUp(tx, rowId, { ok: true, batchId }),
          async (tx, batchId) => {
            await addTopUp(tx, rowId, -amount);
            if (batchId) await forgetBatch(tx, rowId, 'topUpBatchId', batchId);
          }
        );
        const batchId = typeof sent === 'string' ? sent : (sent as { id?: string } | null)?.id;
        if (batchId) await keepSent(hold, rowId, 'topUpBatchId', signed, batchId);
        return sent;
      },
      approvePermit2:
        approve &&
        (async (token) => {
          hold.assertHeld();
          const { sent, signed } = await sendRecorded(
            hold,
            (onSigned) => approve(token, onSigned),
            (tx, approvalBatchId) => recordTopUp(tx, rowId, { ok: true, approvalBatchId }),
            async (tx, batchId) => {
              if (batchId) await forgetBatch(tx, rowId, 'approvalBatchId', batchId);
            }
          );
          await keepSent(hold, rowId, 'approvalBatchId', signed, sent);
          return sent;
        }),
    },
  };
}

const LOST = 'the refill lost its lock while it moved money, so the payment was not signed';
const UNRESERVED = 'the refill moved money but could not reserve the price, so the payment was not signed';
const UNREADABLE = 'the budget could not be read from the chain';

const timedOut = (reason: string): TopUpOutcome => ({ ok: false, code: 'timed_out', reason });

// A waiter gives up when its turn would come too late to send. Once its turn starts the
// refill is never abandoned, so money it moves always reaches the caller's outcome.
function queuedWithin(ms: number, key: string, work: () => Promise<TopUpOutcome>): Promise<TopUpOutcome> {
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<TopUpOutcome>((resolve) => {
    timer = setTimeout(
      () => {
        if (!started) resolve(timedOut('other payments on this connection held the refill too long'));
      },
      Math.max(ms, 0)
    );
  });
  const turn = inTurn(key, () => {
    started = true;
    return work();
  });
  return Promise.race([turn, late]).finally(() => clearTimeout(timer));
}

/**
 * The funding hook `payAndFetch` runs after the probe and before signing: the
 * only place the connection's lock exists, so it never spans a seller fetch.
 * Under it the caps are checked against what earlier turns committed, this row
 * reserves its price, and the payer's balance is read less what every other row
 * still holds, so concurrent payments never sign past a cap or against the same
 * float. The refill is the shortfall plus the gas reserve.
 */
export function refillHook(c: RefillContext): EnsureFunds {
  return (requirement, payer, budget) =>
    queuedWithin(budget.left() - SEND_RESERVE_MS, c.connectionId, async () => {
      const waitMs = budget.left() - SEND_RESERVE_MS;
      if (waitMs < MIN_REFILL_MS) return timedOut('not enough time left to refill the payer and still send');
      let funded: TopUpOutcome | undefined;
      try {
        return await withFloat(c.connectionId, waitMs, async (hold) => {
          // A payment that verified its bearer before a disconnect may get its turn after it.
          const live = await hold.tx(async (tx) => {
            const [row] = await tx
              .select({ id: connections.id })
              .from(connections)
              .where(and(eq(connections.id, c.connectionId), isLive()));
            if (row) await assertOwned(tx, c.rowId, c.token);
            return Boolean(row);
          });
          if (!live) return { ok: false, code: 'not_allowed', reason: 'this connection has ended' };
          // A budget replaced since this payment chose it may be revoked by now, so its refill would revert.
          const [replaced] = await hold.tx((tx) =>
            tx
              .select({ id: grants.permissionId })
              .from(grants)
              .where(and(eq(grants.permissionId, c.grant.permissionId), isNotNull(grants.replacedAt)))
          );
          if (replaced)
            return {
              ok: false,
              code: 'not_allowed',
              reason: 'a newer budget replaced the one this payment chose; pay again',
            };
          // The balance and the nonces it is netted against are read at one block, so a
          // payment mined between two reads is neither in the balance nor held, never both.
          const client = c.clients.publicClient(c.grant.chainId);
          const block = await client.getBlockNumber().catch(() => undefined);
          const held = await stillHeld(await hold.tx((tx) => holdingRows(tx, c.payer, c.rowId)), c.clients, block);
          const session = sessionOf(c.grant);
          const { entries, sent, earlier } = await hold.tx(async (tx) => ({
            entries: await entriesFor(c.grant.permissionId, tx),
            sent: await recordedSends(c.grant.permissionId, tx),
            earlier: await pulledUnderOtherGrants(tx, c.connectionId, c.grant.permissionId),
          }));
          const own = await currentLimitUsageOnChain(entries, c.policy, c.payer, session, new Date(), {
            clients: c.clients,
          });
          const periodUsage = own.map((limit) => ({ ...limit, toppedUp: limit.toppedUp + earlier }));
          const spentThisSession = sumSpentSince(entries, { payer: c.payer }, session.createdAt);
          const verdict = checkCaps(requirement, BigInt(requirement.amount), c.policy, {
            periodUsage: own,
            spentThisSession,
          });
          if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
          const day = await readDaySpend(c.grant, c.payer, entries, sent, c.clients);
          if (!day) return { ok: false, code: 'chain_unavailable', reason: UNREADABLE };
          if (BigInt(requirement.amount) > dayLeft(BigInt(c.grant.allowance), day)) {
            const reason = `payment ${requirement.amount} would pass the ${c.grant.allowance} a day`;
            return { ok: false, code: 'budget_exhausted', reason };
          }
          const refillMs = budget.left() - SEND_RESERVE_MS;
          if (refillMs < MIN_REFILL_MS) return timedOut('the refill waited too long to still send');
          // A send recorded before the counter shows it takes room the policy's ceiling cannot see.
          const ceiling = topUpCeiling(c.policy, { periodUsage, spentThisSession });
          const room = pullRoom(BigInt(c.grant.allowance), day, earlier);
          let pinned = block;
          hold.assertHeld();
          const guard = guarded(c.executor ?? noRefill, hold, c.rowId);
          const outcome = await ensurePayerFunds(requirement, payer, guard.executor, {
            clients: c.clients,
            logger: c.logger,
            sessionChainId: c.grant.chainId,
            maxTopUp: ceiling === undefined || room < ceiling ? room : ceiling,
            funderAddress: c.grant.account,
            floatTarget: c.floatTarget,
            timeoutMs: refillMs,
            balanceReader: async (asset, owner) => {
              const payerRead = isAddressEqual(owner, c.payer);
              // Only the first payer read is pinned: later ones must see the refill land.
              const blockNumber = payerRead ? pinned : undefined;
              if (payerRead) pinned = undefined;
              const balance = await client.readContract({
                address: asset.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [owner],
                blockNumber,
              });
              if (!payerRead) return balance;
              return balance > held ? balance - held : 0n;
            },
          });
          if (guard.failedBeforeSend() !== undefined) throw guard.failedBeforeSend();
          const moved = Boolean(outcome.amount || outcome.batchId || outcome.approvalBatchId);
          if (!moved && !outcome.ok) return outcome;
          // A turn that moved no money commits its reservation under the lock or not at all.
          // Money that moved reaches the caller whatever follows, refused when the lock dropped
          // meanwhile: another turn may have checked the caps since without this payment.
          const lostFunding: TopUpOutcome = { ...outcome, ok: false, code: 'funding_failed', reason: LOST };
          if (!moved) hold.assertHeld();
          else funded = hold.held() ? outcome : lostFunding;
          // The reservation lands with the outcome: holders that read it come after this
          // turn, and a refill killed during the chain wait leaves none behind. owns() holds
          // the connection row against the next holder's fence bump, so that holder reads
          // this reservation, or this turn finds the fence moved and reserves nothing.
          return await hold.tx(async (tx) => {
            if (!(await hold.owns(tx))) {
              if (!moved) throw new FloatLost();
              funded = lostFunding;
            }
            const result = funded ?? outcome;
            if (result.ok) await reserve(tx, c.rowId, c.token, requirement.amount);
            await recordTopUp(tx, c.rowId, result);
            return result;
          });
        });
      } catch (err) {
        // Signing without the reservation would hide this price from the next turn's caps and float.
        if (funded?.ok) {
          logFailure('reservation write failed')(err);
          return { ...funded, ok: false, code: 'funding_failed', reason: UNRESERVED };
        }
        if (funded) return funded;
        if (err instanceof FloatBusy) return timedOut('another payment on this connection held the refill too long');
        throw err;
      }
    });
}
