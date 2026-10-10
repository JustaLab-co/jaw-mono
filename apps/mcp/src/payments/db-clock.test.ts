import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { connect, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { approvalRequests, payments } from '@/db/schema';
import { countHit } from '@/db/settings';
import { TEST_PG_URL, useTestPostgres } from '@/db/test-db';
import { oneOffRow, oneOffStatus, type PaymentApproval } from './one-off';
import { claim, entriesFor, insertOneOff, LEASE_MS, reclaimOneOff } from './store';

setTestEnv();

const SKEW_MS = 90_000;
const request = { url: 'http://seller.test/exact', method: 'GET' as const, headers: {} };

// Only Date is faked: the database keeps the real clock, as a replica's skew leaves it.
function onReplica(skewMs: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + skewMs);
}

/** How long the row's lease has left on the database clock. */
async function leaseLeftMs(id: string): Promise<number> {
  const [{ ms }] = await getDb().execute<{ ms: string }>(
    sql`select extract(epoch from lease_until - statement_timestamp()) * 1000 as ms from payments where id = ${id}`
  );
  return Number(ms);
}

const lapse = (id: string) =>
  getDb()
    .update(payments)
    .set({ leaseUntil: sql`now() - interval '1 second'` })
    .where(eq(payments.id, id));

describe.skipIf(!TEST_PG_URL)('on Postgres, a replica whose clock is off by 90 s', () => {
  let teardown: () => Promise<void>;
  let t: Tenant;
  const owner = () => ({ connectionId: t.connectionId, payer: t.sessionAddress, permissionId: '0x01' });

  beforeAll(async () => {
    teardown = await useTestPostgres();
    const c = await connect();
    t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  });
  afterAll(() => teardown());
  afterEach(() => vi.useRealTimers());

  it('given a replica behind, when it claims a new key, then the lease runs LEASE_MS of database time', async () => {
    onReplica(-SKEW_MS);
    const claimed = await claim(owner(), randomUUID(), request);
    vi.useRealTimers();
    if (claimed.kind !== 'run') throw new Error(claimed.kind);
    expect(await leaseLeftMs(claimed.row.id)).toBeGreaterThan(LEASE_MS - 2_000);
  });

  it('given a lapsed pending row and a replica behind, when it takes the row over, then the new lease runs LEASE_MS', async () => {
    const key = randomUUID();
    const first = await claim(owner(), key, request);
    if (first.kind !== 'run') throw new Error(first.kind);
    await lapse(first.row.id);
    onReplica(-SKEW_MS);
    const taken = await claim(owner(), key, request);
    vi.useRealTimers();
    expect(taken.kind).toBe('run');
    expect(await leaseLeftMs(first.row.id)).toBeGreaterThan(LEASE_MS - 2_000);
  });

  it('given a live lease, when a replica 150 s ahead claims the key, then the row stays busy', async () => {
    const key = randomUUID();
    expect((await claim(owner(), key, request)).kind).toBe('run');
    onReplica(150_000);
    expect((await claim(owner(), key, request)).kind).toBe('busy');
  });

  it('given a lapsed pending row and a replica behind, when it reclaims a one-off, then the new lease runs LEASE_MS', async () => {
    const first = await claim(owner(), randomUUID(), request);
    if (first.kind !== 'run') throw new Error(first.kind);
    await lapse(first.row.id);
    onReplica(-SKEW_MS);
    const taken = await reclaimOneOff(first.row.id);
    vi.useRealTimers();
    expect(taken).toBeDefined();
    expect(await leaseLeftMs(first.row.id)).toBeGreaterThan(LEASE_MS - 2_000);
  });

  async function approval(): Promise<string> {
    const id = `apr_${randomUUID()}`;
    await getDb()
      .insert(approvalRequests)
      .values({
        id,
        connectionId: t.connectionId,
        account: t.account,
        chainId: 84532,
        requester: 'test',
        requesterClientId: 'test',
        kind: 'payment',
        body: {},
        createdAt: sql`now()`,
        expiresAt: sql`now() + interval '5 minutes'`,
      });
    return id;
  }

  const oneOff = (approvalId: string) =>
    oneOffRow(
      { id: approvalId, account: t.sessionAddress, body: { terms: { resource: request.url } } } as PaymentApproval,
      {
        method: 'GET',
        headers: {},
      }
    );

  it('given a replica behind, when an approved one-off opens its row, then the lease runs LEASE_MS', async () => {
    const approvalId = await approval();
    onReplica(-SKEW_MS);
    const row = oneOff(approvalId);
    await getDb().transaction((tx) => insertOneOff(tx, t.connectionId, row));
    vi.useRealTimers();
    expect(await leaseLeftMs(row.id)).toBeGreaterThan(LEASE_MS - 2_000);
  });

  it('given a one-off whose lease lapsed on the database, when a replica behind polls it, then it takes the row to run it', async () => {
    const approvalId = await approval();
    const row = oneOff(approvalId);
    await getDb().transaction((tx) => insertOneOff(tx, t.connectionId, row));
    await lapse(row.id);
    onReplica(-SKEW_MS);
    // The approval was never signed, so the run that follows the takeover refuses to send.
    const polled = oneOffStatus({ id: approvalId, state: { status: 'pending' } } as PaymentApproval);
    await expect(polled).rejects.toThrow('a one-off runs only after a signed approval');
    vi.useRealTimers();
    const [taken] = await getDb().select().from(payments).where(eq(payments.id, row.id));
    expect(taken.leaseToken).not.toBe(row.leaseToken);
  });

  it('given a reservation with 30 s left on the database, when a replica ahead reads the caps, then it counts', async () => {
    const permissionId = `0x${randomUUID().replaceAll('-', '')}`;
    const claimed = await claim({ ...owner(), permissionId }, randomUUID(), request);
    if (claimed.kind !== 'run') throw new Error(claimed.kind);
    await getDb()
      .update(payments)
      .set({ reserved: '5000', leaseUntil: sql`now() + interval '30 seconds'` })
      .where(eq(payments.id, claimed.row.id));
    onReplica(SKEW_MS);
    const entries = await entriesFor(permissionId);
    vi.useRealTimers();
    expect(entries).toMatchObject([{ status: 'failed', authorized: '5000', settlement: 'unverified' }]);
  });

  it('given two replicas 90 s apart, when each counts a hit on one key, then both land in one window', async () => {
    const key = `ip:${randomUUID()}`;
    expect(await countHit(key, 60_000)).toBe(1);
    onReplica(SKEW_MS);
    expect(await countHit(key, 60_000)).toBe(2);
  });
});
