import {
  balanceReader,
  currentLimitUsageOnChain,
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
import { sql } from 'drizzle-orm';
import { isAddressEqual, type Address } from 'viem';
import { sessionOf } from '@/adapters/session-host';
import { getDb } from '@/db/client';
import type { Grant } from '@/grants/store';
import { entriesFor, heldByOthers, recordTopUp, reserve } from './store';

export type EnsureFunds = NonNullable<PayAndFetchOptions['ensureFunds']>;

/** Kept for the paid send when the refill takes its share of the time budget. */
export const SEND_RESERVE_MS = 20_000;
const MIN_REFILL_MS = 5_000;
const LOCK_NOT_AVAILABLE = '55P03';

interface RefillContext {
  rowId: string;
  token: string;
  connectionId: string;
  payer: Address;
  grant: Grant;
  policy: X402Policy;
  executor: TopUpExecutor;
  clients: ChainClients;
  logger: Logger;
}

// Waiters on one connection queue here, so only the one holding the lock pins a pooled connection.
const queues = new Map<string, Promise<unknown>>();

function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, tail);
  void tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

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
 * Under it this row reserves its price, the caps are read again, and the payer's
 * balance is read less what every other row still holds, so concurrent payments
 * never sign against the same float. The refill is the shortfall plus the gas reserve.
 */
export function refillHook(c: RefillContext): EnsureFunds {
  return (requirement, payer, budget) =>
    queuedWithin(budget.left() - SEND_RESERVE_MS, c.connectionId, async () => {
      const waitMs = budget.left() - SEND_RESERVE_MS;
      if (waitMs < MIN_REFILL_MS) return timedOut('not enough time left to refill the payer and still send');
      let funded: TopUpOutcome | undefined;
      try {
        return await getDb().transaction(async (tx) => {
          await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`refill:${c.connectionId}`}))`);
          const refillMs = budget.left() - SEND_RESERVE_MS;
          if (refillMs < MIN_REFILL_MS) return timedOut('the refill waited too long to still send');
          await reserve(tx, c.rowId, c.token, requirement.amount);
          const held = await heldByOthers(tx, c.payer, c.rowId);
          const session = sessionOf(c.grant);
          const entries = await entriesFor(c.grant.permissionId, new Date(), tx);
          const periodUsage = await currentLimitUsageOnChain(entries, c.policy, c.payer, session, new Date(), {
            clients: c.clients,
          });
          const spentThisSession = sumSpentSince(entries, { payer: c.payer }, session.createdAt);
          const onChain = balanceReader(c.clients);
          funded = await ensurePayerFunds(requirement, payer, c.executor, {
            clients: c.clients,
            logger: c.logger,
            sessionChainId: c.grant.chainId,
            maxTopUp: topUpCeiling(c.policy, { periodUsage, spentThisSession }),
            funderAddress: c.grant.account,
            timeoutMs: refillMs,
            balanceReader: async (asset, owner) => {
              const balance = await onChain(asset, owner);
              if (!isAddressEqual(owner, c.payer)) return balance;
              return balance > held ? balance - held : 0n;
            },
          });
          await recordTopUp(tx, c.rowId, funded);
          return funded;
        });
      } catch (err) {
        // Money that moved stays in the outcome, so the row records it even when this transaction did not commit.
        if (funded) return funded;
        const code =
          (err as { code?: unknown; cause?: { code?: unknown } }).code ??
          (err as { cause?: { code?: unknown } }).cause?.code;
        if (code === LOCK_NOT_AVAILABLE) return timedOut('another payment on this connection held the refill too long');
        throw err;
      }
    });
}
