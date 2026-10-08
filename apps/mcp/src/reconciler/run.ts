import type { ChainClients } from '@jaw.id/agent';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { chainClients } from '@/adapters/session-host';
import { getDb } from '@/db/client';
import { approvalRequests, auditEvents, connections, grants, oauthPayloads, payments, rateLimits } from '@/db/schema';
import { log } from '@/lib/edge';
import { chainAnswer, type ChainAnswer } from '@/payments/confirm';
import { claimUnresolved, expire, markAlerted, settle, txHashTaken, type PaymentRow } from '@/payments/store';

export const RECONCILE_AFTER_MS = 60_000;
const STALE_AFTER_MS = 60 * 60_000;
const BATCH = 50;
const READ_MS = 10_000;
// Longer than a run, so a row left open is not claimed twice by the same run, and later runs back off from it.
const CLAIM_MS = 10 * 60_000;

export interface Report {
  settled: number;
  failed: number;
  open: number;
  alerted: number;
}

/**
 * Resolves every signed or unknown row older than the window and not held by a
 * live call. Rows are claimed with SKIP LOCKED and a short lease, the chain is
 * read with no lock held, and each answer is its own conditional update, so two
 * runs split the rows and one bad row never undoes the rest.
 */
export async function reconcile(clients: ChainClients = chainClients, now = new Date()): Promise<Report> {
  const report: Report = { settled: 0, failed: 0, open: 0, alerted: 0 };
  for (;;) {
    const rows = await claimUnresolved(new Date(now.getTime() - RECONCILE_AFTER_MS), CLAIM_MS, BATCH);
    const answers = await Promise.all(rows.map((row) => answerFor(row, clients)));
    for (const [i, row] of rows.entries()) {
      try {
        await apply(row, answers[i], now, report);
      } catch (err) {
        log('error', { msg: `reconcile ${row.id} failed`, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    if (rows.length < BATCH) return report;
  }
}

function answerFor(row: PaymentRow, clients: ChainClients): Promise<ChainAnswer> {
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

async function apply(row: PaymentRow, answer: ChainAnswer, now: Date, report: Report) {
  if (answer.kind === 'settled') {
    // A hash another payment of this payer settled on is not this one's: the signed ceiling stands, without it.
    const taken = answer.txHash && (await txHashTaken(row.payer, answer.txHash, row.id));
    await settle(row.id, taken ? { amount: BigInt(row.authorized as string) } : answer);
    report.settled++;
    return;
  }
  if (answer.kind === 'expired') {
    await expire(row.id);
    report.failed++;
    return;
  }
  report.open++;
  const stale = (row.deadline as Date).getTime() + STALE_AFTER_MS < now.getTime();
  if (!stale || row.alertedAt) return;
  log('error', { msg: `payment ${row.id} is ${row.state} an hour past its deadline` });
  await markAlerted(row.id);
  report.alerted++;
}

export async function purge(): Promise<void> {
  const db = getDb();
  const dayAgo = sql`now() - interval '1 day'`;
  await db.delete(oauthPayloads).where(lt(oauthPayloads.expiresAt, dayAgo));
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, sql`now() - interval '1 hour'`));
  await db.delete(auditEvents).where(lt(auditEvents.createdAt, sql`now() - interval '90 days'`));
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
