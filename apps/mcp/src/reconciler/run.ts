import type { ChainClients } from '@jaw.id/agent';
import { and, asc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { chainClients } from '@/adapters/session-host';
import { getDb } from '@/db/client';
import { approvalRequests, connections, grants, oauthPayloads, payments, rateLimits } from '@/db/schema';
import { log } from '@/lib/edge';
import { chainAnswer, type ChainAnswer } from '@/payments/confirm';

/** A signed row younger than this is still its caller's to finish. */
export const RECONCILE_AFTER_MS = 60_000;
/** A row the chain has not answered by this long after its deadline raises one alert. */
const STALE_AFTER_MS = 60 * 60_000;
const BATCH = 50;
const READ_MS = 10_000;

export interface Report {
  settled: number;
  failed: number;
  open: number;
  alerted: number;
}

type Open = typeof payments.$inferSelect;

/**
 * Resolves every signed or unknown row older than the window against the chain.
 * Each batch is claimed with SKIP LOCKED, so two runs split the rows and each
 * row is answered once; a terminal row is never selected, and the trigger
 * refuses to move one anyway.
 */
export async function reconcile(clients: ChainClients = chainClients, now = new Date()): Promise<Report> {
  const report: Report = { settled: 0, failed: 0, open: 0, alerted: 0 };
  let after: { at: Date; id: string } | undefined;
  for (;;) {
    const rows = await getDb().transaction(async (tx) => {
      const batch = await tx
        .select()
        .from(payments)
        .where(
          and(
            inArray(payments.state, ['signed', 'unknown']),
            lt(payments.signedAt, new Date(now.getTime() - RECONCILE_AFTER_MS)),
            after &&
              or(gt(payments.signedAt, after.at), and(eq(payments.signedAt, after.at), gt(payments.id, after.id)))
          )
        )
        .orderBy(asc(payments.signedAt), asc(payments.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      const answers = await Promise.all(batch.map((row) => answerFor(row, clients)));
      for (const [i, row] of batch.entries()) await apply(tx, row, answers[i], now, report);
      return batch;
    });
    if (rows.length < BATCH) return report;
    const last = rows[rows.length - 1];
    after = { at: last.signedAt as Date, id: last.id };
  }
}

function answerFor(row: Open, clients: ChainClients): Promise<ChainAnswer> {
  return chainAnswer(
    {
      payer: row.payer as Address,
      nonce: row.nonce as Hex,
      scheme: row.scheme as string,
      network: row.network as string,
      payTo: row.payTo as Address,
      authorized: BigInt(row.authorized as string),
      txHash: (row.txHash as Hex | null) ?? undefined,
      deadline: row.deadline as Date,
      signedAt: row.signedAt as Date,
    },
    clients,
    READ_MS
  );
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
const stillOpen = (id: string) => and(eq(payments.id, id), inArray(payments.state, ['signed', 'unknown']));

async function apply(tx: Tx, row: Open, answer: ChainAnswer, now: Date, report: Report) {
  if (answer.kind === 'settled') {
    await tx
      .update(payments)
      .set({
        state: 'settled',
        txHash: answer.txHash,
        blockTime: answer.blockTime,
        amount: answer.amount.toString(),
        finishedAt: now,
      })
      .where(stillOpen(row.id));
    report.settled++;
    return;
  }
  if (answer.kind === 'expired') {
    await tx.update(payments).set({ state: 'failed', finishedAt: now }).where(stillOpen(row.id));
    report.failed++;
    return;
  }
  report.open++;
  const stale = (row.deadline as Date).getTime() + STALE_AFTER_MS < now.getTime();
  if (!stale || row.alertedAt) return;
  log('error', { msg: `payment ${row.id} is ${row.state} an hour past its deadline` });
  await tx.update(payments).set({ alertedAt: now }).where(stillOpen(row.id));
  report.alerted++;
}

/** Deletes what expired and nothing refers to. Payments and decided approvals are kept as evidence. */
export async function purge(): Promise<void> {
  const db = getDb();
  const dayAgo = sql`now() - interval '1 day'`;
  await db.delete(oauthPayloads).where(lt(oauthPayloads.expiresAt, dayAgo));
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, sql`now() - interval '1 hour'`));
  await db
    .delete(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        lt(approvalRequests.expiresAt, dayAgo),
        sql`not exists (select 1 from ${grants} where ${grants.approvalId} = ${approvalRequests.id})`
      )
    );
  await db
    .delete(connections)
    .where(
      and(
        eq(connections.status, 'pending'),
        lt(connections.expiresAt, dayAgo),
        sql`not exists (select 1 from ${approvalRequests} where ${approvalRequests.connectionId} = ${connections.id})`,
        sql`not exists (select 1 from ${grants} where ${grants.connectionId} = ${connections.id})`,
        sql`not exists (select 1 from ${payments} where ${payments.connectionId} = ${connections.id})`
      )
    );
}
