import {
  balanceReader,
  ensurePayerFunds,
  topUpCeiling,
  type ChainClients,
  type LimitUsage,
  type Logger,
  type PayAndFetchOptions,
  type TopUpExecutor,
  type X402Policy,
} from '@jaw.id/agent';
import { sql } from 'drizzle-orm';
import { isAddressEqual, type Address } from 'viem';
import { getDb } from '@/db/client';
import type { Grant } from '@/grants/store';
import { heldByOthers, recordTopUp, reserve } from './store';

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
  periodUsage: LimitUsage[];
  spentThisSession: bigint;
  executor: TopUpExecutor;
  clients: ChainClients;
  logger: Logger;
}

/**
 * The funding hook `payAndFetch` runs after the probe and before signing: the
 * only place the connection's lock exists, so it can never span a seller fetch.
 * Under it this row reserves its price, and the payer's balance is read less
 * what every other row of the payer still holds, so concurrent payments never
 * sign against the same float. The refill is the shortfall plus the gas reserve.
 */
export function refillHook(c: RefillContext): EnsureFunds {
  return async (requirement, payer, budget) => {
    const left = budget.left() - SEND_RESERVE_MS;
    if (left < MIN_REFILL_MS) {
      return { ok: false, code: 'timed_out', reason: 'not enough time left to refill the payer and still send' };
    }
    try {
      return await getDb().transaction(async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout', ${`${left}ms`}, true)`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`refill:${c.connectionId}`}))`);
        await reserve(tx, c.rowId, c.token, requirement.amount);
        const held = await heldByOthers(tx, c.payer, c.rowId);
        const onChain = balanceReader(c.clients);
        const funded = await ensurePayerFunds(requirement, payer, c.executor, {
          clients: c.clients,
          logger: c.logger,
          sessionChainId: c.grant.chainId,
          maxTopUp: topUpCeiling(c.policy, { periodUsage: c.periodUsage, spentThisSession: c.spentThisSession }),
          funderAddress: c.grant.account,
          timeoutMs: left,
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
      // 55P03: the lock wait outlasted the budget, before anything moved.
      if (
        (err as { code?: unknown }).code === '55P03' ||
        (err as { cause?: { code?: unknown } }).cause?.code === '55P03'
      ) {
        return { ok: false, code: 'timed_out', reason: 'another payment on this connection held the refill too long' };
      }
      throw err;
    }
  };
}
