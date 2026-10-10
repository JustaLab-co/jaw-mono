import {
  checkCaps,
  currentLimitUsageOnChain,
  usdcForNetwork,
  ensurePayerFunds,
  sumSpentSince,
  topUpCeiling,
  type ChainClients,
  type Logger,
  type PayAndFetchOptions,
  type TopUpExecutor,
  type TopUpOutcome,
  type X402Policy,
} from '@jaw.id/agent';
import { and, eq } from 'drizzle-orm';
import { erc20Abi, isAddressEqual, type Address, type Hex } from 'viem';
import { sessionOf } from '@/adapters/session-host';
import { isLive } from '@/connections/rows';
import { connections } from '@/db/schema';
import type { Grant } from '@/grants/store';
import { nonceUsed } from './confirm';
import { FloatBusy, inTurn, withFloat, type FloatHold } from './float-lock';
import {
  assertOwned,
  entriesFor,
  holdingRows,
  pulledUnderOtherGrants,
  recordTopUp,
  reserve,
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

function guarded(executor: TopUpExecutor, hold: FloatHold): TopUpExecutor {
  const approve = executor.approvePermit2?.bind(executor);
  return {
    request: (method, params) => {
      if (method === 'wallet_sendCalls') hold.assertHeld();
      return executor.request(method, params);
    },
    approvePermit2:
      approve &&
      (async (token) => {
        hold.assertHeld();
        return approve(token);
      }),
  };
}

const LOST = 'the refill lost its lock while it moved money, so the payment was not signed';

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
          // The balance and the nonces it is netted against are read at one block, so a
          // payment mined between two reads is neither in the balance nor held, never both.
          const client = c.clients.publicClient(c.grant.chainId);
          const block = await client.getBlockNumber().catch(() => undefined);
          const held = await stillHeld(await hold.tx((tx) => holdingRows(tx, c.payer, c.rowId)), c.clients, block);
          const session = sessionOf(c.grant);
          const { entries, earlier } = await hold.tx(async (tx) => ({
            entries: await entriesFor(c.grant.permissionId, tx),
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
          const refillMs = budget.left() - SEND_RESERVE_MS;
          if (refillMs < MIN_REFILL_MS) return timedOut('the refill waited too long to still send');
          let pinned = block;
          hold.assertHeld();
          const outcome = await ensurePayerFunds(requirement, payer, guarded(c.executor ?? noRefill, hold), {
            clients: c.clients,
            logger: c.logger,
            sessionChainId: c.grant.chainId,
            maxTopUp: topUpCeiling(c.policy, { periodUsage, spentThisSession }),
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
          const moved = Boolean(outcome.amount || outcome.batchId || outcome.approvalBatchId);
          if (!moved && !outcome.ok) return outcome;
          // A turn that moved no money commits its reservation under the lock or not at all.
          // Money that moved reaches the caller whatever follows, refused when the lock dropped
          // meanwhile: another turn may have checked the caps since without this payment.
          if (!moved) hold.assertHeld();
          else funded = hold.held() ? outcome : { ...outcome, ok: false, code: 'funding_failed', reason: LOST };
          const result = funded ?? outcome;
          // The reservation lands with the outcome: holders that read it come after this
          // turn, and a refill killed during the chain wait leaves none behind.
          await hold.tx(async (tx) => {
            if (result.ok) await reserve(tx, c.rowId, c.token, requirement.amount);
            await recordTopUp(tx, c.rowId, result);
          });
          return result;
        });
      } catch (err) {
        if (funded) return funded;
        if (err instanceof FloatBusy) return timedOut('another payment on this connection held the refill too long');
        throw err;
      }
    });
}
