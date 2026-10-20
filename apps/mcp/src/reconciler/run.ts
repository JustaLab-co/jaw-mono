import type { ChainClients, PermissionState } from '@jaw.id/agent';
import { and, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { getAbiItem, type Address, type Hex } from 'viem';
import { entryPoint08Abi, entryPoint08Address } from 'viem/account-abstraction';
import { chainClients } from '@/adapters/session-host';
import { config } from '@/connections/config';
import { retire, sessionSender, type DisconnectDeps } from '@/connections/disconnect';
import { claimSealedKey, endConnection, restoreSealedKey } from '@/connections/rows';
import { open, type Sealed } from '@/connections/seal';
import { getDb } from '@/db/client';
import { auditEvents, connections, grants, oauthPayloads, ownerCalls, payments, rateLimits, swaps } from '@/db/schema';
import { isPaymentsPaused } from '@/db/settings';
import { readOnChain, type ReadPermission } from '@/grants/permission';
import { recordRevoked, sampleLiveGrants } from '@/grants/store';
import { errorLabel, log } from '@/lib/edge';
import { conclude, sentBefore } from '@/owner-calls/store';
import { canSearchChain, readReceipt, searchChain, type ReadReceipt } from '@/owner-calls/receipt';
import { chainAnswer, type ChainAnswer } from '@/payments/confirm';
import { claimOpenSends, settleSends, type SendEnd, type SendRow } from '@/payments/sends';
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
  sends: { landed: number; released: number; open: number };
  ownerCalls: { landed: number; reverted: number; open: number };
}

/**
 * Resolves every signed or unknown row older than the window and not held by a
 * live call. Rows are claimed with SKIP LOCKED and marked for `CLAIM_MS`, the
 * chain is read with no lock held, and each answer is its own conditional
 * update, so two runs split the rows and one bad row never undoes the rest.
 */
export async function reconcile(
  clients: ChainClients = chainClients,
  now = new Date(),
  receipt: ReadReceipt = readReceipt
): Promise<Report> {
  const report: Report = {
    settled: 0,
    failed: 0,
    open: 0,
    alerted: 0,
    sends: { landed: 0, released: 0, open: 0 },
    ownerCalls: { landed: 0, reverted: 0, open: 0 },
  };
  await reconcileSends(clients, report);
  await reconcileOwnerCalls(receipt, clients, now, report);
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

// Some RPC providers cap eth_getLogs at 500 blocks.
const SEND_WINDOW_BLOCKS = 450n;
const userOperationEvent = getAbiItem({ abi: entryPoint08Abi, name: 'UserOperationEvent' });

async function reconcileSends(clients: ChainClients, report: Report) {
  for (;;) {
    const rows = await claimOpenSends(CLAIM_MS, BATCH);
    for (const row of rows) {
      try {
        const end = await sendOutcome(row, clients);
        if (!end) {
          report.sends.open++;
          continue;
        }
        await settleSends([row.id], end);
        report.sends[end.state]++;
      } catch (err) {
        log('error', { msg: `reconcile ${row.id} failed`, error: errorLabel(err) });
        report.sends.open++;
      }
    }
    if (rows.length < BATCH) return;
  }
}

async function sendOutcome(row: SendRow, clients: ChainClients): Promise<SendEnd | undefined> {
  const client = clients.publicClient(row.chainId);
  const head = await client.getBlockNumber();
  const windowEnd = row.fromBlock + SEND_WINDOW_BLOCKS;
  const fromTransfer = row.idempotencyKey === null;
  if (!fromTransfer && !row.callsId) return head >= windowEnd ? { state: 'released' } : undefined;
  const logs = await client.getLogs({
    address: entryPoint08Address,
    event: userOperationEvent,
    args: row.callsId ? { userOpHash: row.callsId as Hex } : { sender: row.sender as Address },
    fromBlock: row.fromBlock,
    toBlock: head < windowEnd ? head : windowEnd,
    strict: true,
  });
  const landed = logs.find((l) => l.args.success);
  if (landed) return { state: 'landed', txHash: landed.transactionHash };
  if (row.callsId && logs.length > 0) return { state: 'released', txHash: logs[0].transactionHash };
  if (head >= windowEnd) return { state: 'released' };
  return undefined;
}

// Each chain search can take dozens of log reads. The rows come in random order, so a few rows
// that never land cannot take every run's searches from the rest.
const CHAIN_SEARCHES_PER_RUN = 5;

/**
 * Sent calls nobody asked about again. One batch per run: rows still waiting for a
 * receipt are read again next run, and `jaw_get_calls_status` concludes the same
 * way, so whichever lands first wins. A row stuck at `send_started` has no calls
 * id to look up by, so it is left alone.
 */
async function reconcileOwnerCalls(receipt: ReadReceipt, clients: ChainClients, now: Date, report: Report) {
  const rows = await sentBefore(RECONCILE_AFTER_MS, BATCH);
  let chainSearches = 0;
  await Promise.all(
    rows.map(async (row) => {
      try {
        let mined = await receipt(row.chainId, row.callsId as string);
        if (!mined && canSearchChain(row, now.getTime()) && chainSearches++ < CHAIN_SEARCHES_PER_RUN) {
          mined = await searchChain(row, clients, now.getTime());
        }
        if (!mined) {
          report.ownerCalls.open++;
          return;
        }
        const state = mined.success ? 'landed' : 'reverted';
        if (await conclude(row.connectionId, row.id, state, mined.txHash)) report.ownerCalls[state]++;
      } catch (err) {
        log('warn', { msg: `owner call ${row.id} not settled`, error: errorLabel(err) });
        report.ownerCalls.open++;
      }
    })
  );
}

const GRANTS_PER_SWEEP = 25;

export async function sweepRevokedGrants(
  read: ReadPermission = readOnChain,
  limit = GRANTS_PER_SWEEP
): Promise<number | null> {
  try {
    let recorded = 0;
    // One at a time: the payment path reads the same RPC, and a burst can get it rate limited.
    for (const g of await sampleLiveGrants(limit)) {
      const state = await read({ chainId: g.chainId, permissionId: g.permissionId, permission: g.permission }).catch(
        (): PermissionState => ({ status: 'unavailable' })
      );
      if (state.status === 'unavailable') return null;
      if (state.status === 'ok' && state.revoked) recorded += await recordRevoked([g.permissionId]);
    }
    return recorded;
  } catch (err) {
    log('error', { msg: 'grant sweep failed', error: errorLabel(err) });
    return null;
  }
}

const SESSION_DEPS: DisconnectDeps = { readPermission: readOnChain, clients: chainClients, sender: sessionSender };

export async function purge(deps = SESSION_DEPS): Promise<void> {
  const db = getDb();
  const dayAgo = sql`now() - interval '1 day'`;
  await db.delete(oauthPayloads).where(lt(oauthPayloads.expiresAt, dayAgo));
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, sql`now() - interval '1 hour'`));
  await db.delete(auditEvents).where(lt(auditEvents.createdAt, sql`now() - interval '90 days'`));
  await retireAbandoned(deps);
  await retireUnexchanged(deps);
  await db
    .delete(connections)
    .where(
      and(
        eq(connections.status, 'pending'),
        lt(connections.expiresAt, dayAgo),
        isNull(connections.sealedKey),
        sql`not exists (select 1 from ${grants} where ${grants.connectionId} = ${connections.id})`,
        sql`not exists (select 1 from ${payments} where ${payments.connectionId} = ${connections.id})`,
        sql`not exists (select 1 from ${swaps} where ${swaps.connectionId} = ${connections.id})`,
        sql`not exists (select 1 from ${ownerCalls} where ${ownerCalls.connectionId} = ${connections.id})`
      )
    );
}

/**
 * Approved in the wallet but never completed: nobody holds a token for it, so its
 * key goes. First the key revokes the budget and returns the prefund the grant
 * sent it, since nothing else can. A run that cannot keeps the key for the next.
 */
async function retireAbandoned(deps: DisconnectDeps) {
  if (await isPaymentsPaused()) return;
  const rows = await getDb()
    .select()
    .from(connections)
    .where(
      and(eq(connections.status, 'pending'), lt(connections.expiresAt, sql`now()`), isNotNull(connections.sealedKey))
    )
    .limit(BATCH);
  for (const row of rows) {
    const outcome = await retire(
      {
        connectionId: row.id,
        account: row.account as Address,
        chainId: row.chainId,
        sessionAddress: row.sessionAddress as Address,
        sessionKey: () => open(config().ring, row.sealedKey as Sealed, row.id),
      },
      deps
    ).catch((err: unknown) => errorLabel(err));
    if (typeof outcome === 'string') {
      log('error', { msg: `abandoned connection ${row.id} not retired`, error: outcome });
      continue;
    }
    // What is left is under the fee to move it, if anything.
    await getDb().update(connections).set({ sealedKey: null }).where(eq(connections.id, row.id));
  }
}

// AuthorizationCode TTL (60 s, provider.ts) plus two minutes for clock skew and slow networks.
export const EXCHANGE_WINDOW_MS = 180_000;
const exchangeDeadline = sql.raw(`now() - interval '${EXCHANGE_WINDOW_MS} milliseconds'`);

/**
 * Activated but never exchanged, or revoked by a hand_back_failed: the code
 * expired and no token will ever wrap the key, so it stays env-sealed until
 * this clears it. Claims the key atomically so a late takeSealedKey cannot
 * also get it (one winner), restores on failure so the next run retries.
 */
async function retireUnexchanged(deps: DisconnectDeps) {
  const rows = await getDb()
    .select()
    .from(connections)
    .where(
      and(
        isNotNull(connections.sealedKey),
        isNotNull(connections.activatedAt),
        lt(connections.activatedAt, exchangeDeadline),
        ne(connections.status, 'pending')
      )
    )
    .limit(BATCH);
  if (rows.length === 0) return;
  const paused = await isPaymentsPaused();
  if (paused) {
    log('error', { msg: `${rows.length} sealed key(s) past the exchange window while payments are paused` });
    return;
  }
  for (const row of rows) {
    const claimed = await claimSealedKey(row.id);
    if (!claimed) continue;
    const outcome = await retire(
      {
        connectionId: row.id,
        account: row.account as Address,
        chainId: row.chainId,
        sessionAddress: row.sessionAddress as Address,
        sessionKey: () => open(config().ring, claimed, row.id),
      },
      deps
    ).catch((err: unknown) => errorLabel(err));
    if (typeof outcome === 'string') {
      await restoreSealedKey(row.id, claimed);
      log('error', { msg: `unexchanged connection ${row.id} not retired`, error: outcome });
      continue;
    }
    await endConnection(row.id, row.account as Address);
  }
}
