import { randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, ownerCalls } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres, withoutOwnerCallsGuard } from '@/db/test-db';
import { purge } from '@/reconciler/run';
import {
  conclude,
  decline,
  expirePast,
  findById,
  findByKey,
  findOpen,
  insertOwnerCall,
  markSendStarted,
  markSent,
  renewSession,
  endSession,
  reopenLink,
  SEND_STARTED,
  setCode,
  type OwnerCallRow,
} from './store';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CALL = { to: '0x2222222222222222222222222222222222222222', data: '0xa9059cbb', value: '0' };
const URL_A = 'https://keys.test/cli-bridge#a';
const URL_B = 'https://keys.test/cli-bridge#b';
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000);
const DB_MINUTE = sql`interval '1 minute'`;

setTestEnv();

beforeAll(async () => {
  if (TEST_PG_URL) await useTestPostgres();
  else await useTestDb();
});

async function newConnection(over: Partial<typeof connections.$inferInsert> = {}): Promise<string> {
  const id = `con_${randomUUID()}`;
  await getDb()
    .insert(connections)
    .values({
      id,
      status: 'active',
      account: ACCOUNT,
      chainId: 8453,
      clientId: 'client',
      clientName: 'client',
      scopes: ['wallet:read'],
      interactionUid: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      grantId: randomUUID(),
      activatedAt: new Date(),
      ...over,
    });
  return id;
}

async function open(connectionId: string, over: { key?: string; approveBy?: Date; calls?: unknown[] } = {}) {
  const row = await insertOwnerCall({
    connectionId,
    key: over.key ?? randomUUID(),
    requestHash: 'hash',
    chainId: 8453,
    account: ACCOUNT,
    calls: (over.calls ?? [CALL]) as OwnerCallRow['calls'],
    walletUrl: URL_A,
    approveBy: over.approveBy ?? inMinutes(10),
  });
  if (!row) throw new Error('not inserted');
  return row;
}

const rowOf = async (id: string): Promise<OwnerCallRow> =>
  (await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, id)))[0];

const refusalOf = (write: Promise<unknown>) =>
  write.then(
    () => 'written',
    (e: Error & { cause?: Error }) => e.cause?.message ?? e.message
  );

/** Moves approve_by one minute behind the database clock, which is the one the store compares with. */
const lapse = (id: string) =>
  withoutOwnerCallsGuard(() =>
    getDb().execute(sql`update owner_calls set approve_by = statement_timestamp() - ${DB_MINUTE} where id = ${id}`)
  );

const setLease = (id: string, sessionUntil: SQL | null) =>
  getDb().update(ownerCalls).set({ sessionUntil }).where(eq(ownerCalls.id, id));
const lapseLease = (id: string) => setLease(id, sql`statement_timestamp() - interval '1 second'`);

const set = (id: string, values: Partial<typeof ownerCalls.$inferInsert>) =>
  getDb().update(ownerCalls).set(values).where(eq(ownerCalls.id, id));

const STATES = ['awaiting_owner', 'owner_declined', 'expired', 'sent', 'landed', 'reverted'] as const;

async function rowIn(state: (typeof STATES)[number]): Promise<OwnerCallRow> {
  const row = await open(await newConnection());
  const { connectionId, id } = row;
  if (state === 'expired') await lapse(id);
  if (state === 'owner_declined') await decline(row, 'owner_declined');
  if (state === 'expired') await expirePast(connectionId);
  if (['sent', 'landed', 'reverted'].includes(state)) await markSent(row, '0xcalls');
  if (state === 'landed' || state === 'reverted') await conclude(connectionId, id, state, '0xtx');
  return rowOf(id);
}

describe('insert and find', () => {
  it('given a new request, then the row is awaiting_owner with an oc_ id', async () => {
    const row = await open(await newConnection());
    expect(row).toMatchObject({ state: 'awaiting_owner', code: null, walletUrl: URL_A, callsId: null });
    expect(row.id).toMatch(/^oc_[A-Za-z0-9_-]{22}$/);
  });

  it('given a key already used on the connection, then the insert returns null and the row is kept', async () => {
    const connectionId = await newConnection();
    const first = await open(connectionId, { key: 'k' });
    await set(first.id, { state: 'owner_declined', code: 'owner_declined' });
    const again = await insertOwnerCall({
      connectionId,
      key: 'k',
      requestHash: 'other',
      chainId: 1,
      account: ACCOUNT,
      calls: [CALL],
      walletUrl: URL_B,
      approveBy: inMinutes(10),
    });
    expect(again).toBeNull();
    expect((await findByKey(connectionId, 'k'))?.id).toBe(first.id);
  });

  it('given the same key on two connections, then both insert', async () => {
    await open(await newConnection(), { key: 'shared' });
    await open(await newConnection(), { key: 'shared' });
  });

  it('given a second awaiting request on the connection, then the insert returns null', async () => {
    const connectionId = await newConnection();
    const first = await open(connectionId);
    const second = await insertOwnerCall({
      connectionId,
      key: 'second',
      requestHash: 'hash',
      chainId: 8453,
      account: ACCOUNT,
      calls: [CALL],
      walletUrl: URL_A,
      approveBy: inMinutes(10),
    });
    expect(second).toBeNull();
    expect((await findOpen(connectionId))?.id).toBe(first.id);
  });

  it('given a finished request, then another can open and findOpen skips the finished one', async () => {
    const connectionId = await newConnection();
    const first = await open(connectionId);
    await decline(first, 'owner_declined');
    expect(await findOpen(connectionId)).toBeUndefined();
    await open(connectionId);
  });

  it('given a row of another connection, then findById does not see it', async () => {
    const row = await open(await newConnection());
    expect(await findById(await newConnection(), row.id)).toBeUndefined();
    expect((await findById(row.connectionId, row.id))?.id).toBe(row.id);
  });

  it('given exactly ten calls, then the row is stored', async () => {
    const row = await open(await newConnection(), { calls: Array(10).fill(CALL) });
    expect(row.calls).toHaveLength(10);
  });

  it('given zero or eleven calls, then the database refuses', async () => {
    const connectionId = await newConnection();
    const insert = (calls: unknown[]) => refusalOf(open(connectionId, { calls }));
    expect(await insert([])).toMatch(/owner_call_shape/);
    expect(await insert(Array(11).fill(CALL))).toMatch(/owner_call_shape/);
  });
});

describe('expirePast', () => {
  it('given an awaiting row past approve_by, then it expires; a live one and other connections are untouched', async () => {
    const connectionId = await newConnection();
    const lapsed = await open(connectionId);
    const other = await open(await newConnection());
    await lapse(lapsed.id);
    await lapse(other.id);

    await expirePast(connectionId);

    expect((await rowOf(lapsed.id)).state).toBe('expired');
    expect((await rowOf(other.id)).state).toBe('awaiting_owner');
    const live = await open(connectionId);
    await expirePast(connectionId);
    expect((await rowOf(live.id)).state).toBe('awaiting_owner');
  });
});

describe('reopenLink', () => {
  it('given a link with a wallet error, then it takes a new url and clears the code', async () => {
    const row = await open(await newConnection());
    await lapseLease(row.id);
    await setCode(row, 'wallet_error:-32000');
    const reopened = await reopenLink(row, URL_B);
    expect(reopened).toMatchObject({ walletUrl: URL_B, code: null, approveBy: row.approveBy });
  });

  it('given a row the wallet was asked to send, then the link does not reopen', async () => {
    const row = await open(await newConnection());
    await markSendStarted(row);
    expect(await reopenLink(row, URL_B)).toBeUndefined();
    expect((await rowOf(row.id)).walletUrl).toBe(URL_A);
  });

  it('given a row that lapsed or ended, then the link does not reopen', async () => {
    for (const state of ['expired', 'owner_declined'] as const) {
      const row = await rowIn(state);
      expect(await reopenLink(row, URL_B)).toBeUndefined();
    }
  });

  it('given an awaiting row past approve_by that nobody expired, then the link does not reopen', async () => {
    const row = await open(await newConnection());
    await lapse(row.id);
    expect(row.state).toBe('awaiting_owner');
    expect(await reopenLink(row, URL_B)).toBeUndefined();
    expect((await rowOf(row.id)).walletUrl).toBe(URL_A);
  });

  it('given a stale url, then the link does not reopen', async () => {
    const row = await open(await newConnection());
    await reopenLink(row, URL_B);
    expect(await reopenLink(row, 'https://keys.test/cli-bridge#c')).toBeUndefined();
  });
});

describe('setCode and decline', () => {
  it('given an awaiting row, then the code is recorded', async () => {
    const row = await open(await newConnection());
    expect((await setCode(row, 'wallet_error:4100'))?.code).toBe('wallet_error:4100');
  });

  it('given an expired or sent row, then the code is not written', async () => {
    for (const state of ['expired', 'sent'] as const) {
      const row = await rowIn(state);
      expect(await setCode(row, 'wallet_error:1')).toBeUndefined();
    }
  });

  it('given a row the wallet was asked to send, then the marker is not replaced', async () => {
    const row = await open(await newConnection());
    await markSendStarted(row);
    expect(await setCode(row, 'wallet_error:1')).toBeUndefined();
    expect((await rowOf(row.id)).code).toBe(SEND_STARTED);
  });

  it('given an awaiting row, when declined, then it is owner_declined, finished, and keeps the code', async () => {
    const row = await open(await newConnection());
    const declined = await decline(row, 'wrong_account');
    expect(declined).toMatchObject({ state: 'owner_declined', code: 'wrong_account', finishedAt: expect.any(Date) });
  });

  it('given a sent row, when declined, then nothing is written', async () => {
    const row = await rowIn('sent');
    expect(await decline(row, 'owner_declined')).toBeUndefined();
  });

  it('given an expired row, when declined, then nothing is written and it stays expired', async () => {
    const row = await rowIn('expired');
    expect(await decline(row, 'owner_declined')).toBeUndefined();
    expect((await rowOf(row.id)).state).toBe('expired');
  });
});

describe('markSendStarted', () => {
  it('given a live awaiting row with no code, then the marker is written, passes the run that holds the row again and refuses any other', async () => {
    const row = await open(await newConnection());
    expect(await markSendStarted(row)).toBe(true);
    expect((await rowOf(row.id)).code).toBe(SEND_STARTED);
    expect(await markSendStarted(row)).toBe(true);
    expect(await markSendStarted({ ...row, leaseHolder: 'another process' })).toBe(false);
  });

  it('given a row past approve_by that nobody expired, then the marker is refused', async () => {
    const row = await open(await newConnection());
    await lapse(row.id);
    expect(await markSendStarted(row)).toBe(false);
    expect((await rowOf(row.id)).code).toBeNull();
  });

  it('given a row with a wallet error, then the marker is refused', async () => {
    const row = await open(await newConnection());
    await setCode(row, 'wallet_error:1');
    expect(await markSendStarted(row)).toBe(false);
  });

  it('given a row of another connection, then the marker is refused', async () => {
    const row = await open(await newConnection());
    expect(await markSendStarted({ ...row, connectionId: await newConnection() })).toBe(false);
  });
});

describe('markSent and conclude', () => {
  it.each(['awaiting_owner', 'expired'] as const)(
    'given a %s row, then the calls id moves it to sent',
    async (from) => {
      const row = await rowIn(from);
      await markSendStarted(row);
      const sent = await markSent(row, '0xcalls');
      expect(sent).toMatchObject({ state: 'sent', callsId: '0xcalls', code: null });
    }
  );

  it('given a head block, then markSent stores it with the move to sent', async () => {
    const row = await rowIn('awaiting_owner');
    const sent = await markSent(row, '0xcalls', 48_153_900n);
    expect(sent).toMatchObject({ state: 'sent', sentBlock: 48_153_900n });
  });

  it('given no head block, then markSent still moves the row to sent with a null sent block', async () => {
    const row = await rowIn('awaiting_owner');
    expect(await markSent(row, '0xcalls', null)).toMatchObject({ state: 'sent', sentBlock: null });
  });

  it('given a declined row, then markSent writes nothing', async () => {
    const row = await rowIn('owner_declined');
    expect(await markSent(row, '0xcalls')).toBeUndefined();
  });

  it.each(['landed', 'reverted'] as const)(
    'given a sent row, then %s keeps the tx hash and finishes',
    async (state) => {
      const row = await rowIn('sent');
      const done = await conclude(row.connectionId, row.id, state, '0xtx');
      expect(done).toMatchObject({ state, txHash: '0xtx', finishedAt: expect.any(Date) });
    }
  );

  it('given a row that is not sent, then conclude writes nothing', async () => {
    const row = await rowIn('awaiting_owner');
    expect(await conclude(row.connectionId, row.id, 'landed', '0xtx')).toBeUndefined();
  });

  it('given an expired row, then conclude writes nothing and it stays expired', async () => {
    const row = await rowIn('expired');
    expect(await conclude(row.connectionId, row.id, 'landed', '0xtx')).toBeUndefined();
    expect((await rowOf(row.id)).state).toBe('expired');
  });
});

describe('the guard', () => {
  const allowed = new Set([
    'awaiting_owner>owner_declined',
    'awaiting_owner>expired',
    'awaiting_owner>sent',
    'expired>sent',
    'sent>landed',
    'sent>reverted',
  ]);
  const pairs = STATES.flatMap((from) => STATES.filter((to) => to !== from).map((to) => [from, to] as const));

  it.each(pairs.filter(([from, to]) => !allowed.has(`${from}>${to}`)))(
    'given a %s row, when it moves to %s, then the database refuses',
    async (from, to) => {
      const row = await rowIn(from);
      const write = set(row.id, { state: to, callsId: '0xc', txHash: '0xt' });
      expect(await refusalOf(write)).toMatch(/is not a transition|final/);
    }
  );

  it.each(['owner_declined', 'landed', 'reverted'] as const)(
    'given a %s row, then it is final and finished',
    async (state) => {
      const row = await rowIn(state);
      expect(row.finishedAt).toEqual(expect.any(Date));
      expect(await refusalOf(set(row.id, { code: 'x' }))).toMatch(new RegExp(`is ${state} and final`));
    }
  );

  it.each(['awaiting_owner', 'expired', 'sent'] as const)('given a %s row, then it is not finished', async (state) => {
    expect((await rowIn(state)).finishedAt).toBeNull();
  });

  it('given any row, when it is deleted, then the database refuses', async () => {
    const row = await rowIn('awaiting_owner');
    expect(await refusalOf(getDb().delete(ownerCalls).where(eq(ownerCalls.id, row.id)))).toMatch(/never deleted/);
  });

  it('given a write, then updated_at moves to the time of that write', async () => {
    const row = await rowIn('awaiting_owner');
    const ageMinutes = async () => {
      const [{ age }] = await getDb()
        .select({ age: sql<string>`extract(epoch from statement_timestamp() - ${ownerCalls.updatedAt}) / 60` })
        .from(ownerCalls)
        .where(eq(ownerCalls.id, row.id));
      return Number(age);
    };
    await withoutOwnerCallsGuard(() =>
      getDb().execute(
        sql`update owner_calls set updated_at = statement_timestamp() - interval '1 hour' where id = ${row.id}`
      )
    );
    expect(await ageMinutes()).toBeGreaterThan(59);

    await setCode(row, 'wallet_error:1');

    expect(await ageMinutes()).toBeLessThan(1);
  });

  it.each([
    ['chain', { chainId: 10 }],
    ['account', { account: '0x3333333333333333333333333333333333333333' }],
    ['calls', { calls: [{ ...CALL, data: '0xdeadbeef' }] }],
    ['request hash', { requestHash: 'other' }],
    ['idempotency key', { idempotencyKey: 'other' }],
    ['approve by', { approveBy: new Date(0) }],
  ])('given an awaiting row, when its %s changes, then the database refuses', async (_, values) => {
    const row = await rowIn('awaiting_owner');
    expect(await refusalOf(set(row.id, values))).toMatch(/the request is immutable/);
  });

  it('given an awaiting row, when its id or connection changes, then the database refuses', async () => {
    const row = await rowIn('awaiting_owner');
    expect(await refusalOf(set(row.id, { id: 'oc_other' }))).toMatch(/the request is immutable/);
    expect(await refusalOf(set(row.id, { connectionId: await newConnection() }))).toMatch(/the request is immutable/);
  });

  it.each(['expired', 'owner_declined'] as const)(
    'given an awaiting row, when it moves to %s with a new wallet url, then the database refuses',
    async (to) => {
      const row = await rowIn('awaiting_owner');
      expect(await refusalOf(set(row.id, { state: to, walletUrl: URL_B }))).toMatch(/written once/);
    }
  );

  it('given a sent row, when its calls id or tx hash is rewritten, then the database refuses', async () => {
    const row = await rowIn('sent');
    expect(await refusalOf(set(row.id, { callsId: '0xother' }))).toMatch(/written once/);
  });

  it('given a sent row, when the tx hash is set and then changed, then the second write is refused', async () => {
    const row = await rowIn('sent');
    await set(row.id, { txHash: '0xfirst' });
    expect(await refusalOf(set(row.id, { txHash: '0xsecond' }))).toMatch(/written once/);
  });

  it('given a sent row without a sent block, when one is written, then it is accepted once and a rewrite is refused', async () => {
    const row = await rowIn('sent');
    expect(row.sentBlock).toBeNull();
    expect(await refusalOf(set(row.id, { sentBlock: 100n }))).toBe('written');
    expect(await refusalOf(set(row.id, { sentBlock: 200n }))).toMatch(/written once/);
    expect(await refusalOf(set(row.id, { sentBlock: null }))).toMatch(/written once/);
    expect((await rowOf(row.id)).sentBlock).toBe(100n);
  });

  it('given a sent row with a sent block, when it concludes, then the sent block stays', async () => {
    const row = await rowIn('awaiting_owner');
    await markSent(row, '0xcalls', 77n);
    expect(await conclude(row.connectionId, row.id, 'landed', '0xtx')).toMatchObject({ sentBlock: 77n });
  });

  it.each([
    ['an awaiting row holding the send marker', 'awaiting_owner', SEND_STARTED],
    ['an expired row', 'expired', null],
  ] as const)('given %s, when its wallet url is rewritten, then the database refuses', async (_, state, code) => {
    const row = await rowIn(state);
    if (code) await set(row.id, { code });
    expect(await refusalOf(set(row.id, { walletUrl: URL_B }))).toMatch(/written once/);
  });

  it('given an awaiting row, when its wallet url is rewritten, then it is accepted', async () => {
    const row = await rowIn('awaiting_owner');
    await lapseLease(row.id);
    expect(await refusalOf(set(row.id, { walletUrl: URL_B }))).toBe('written');
  });

  it('given an awaiting row, when it moves to sent without a calls id, then the shape check refuses', async () => {
    const row = await rowIn('awaiting_owner');
    expect(await refusalOf(set(row.id, { state: 'sent' }))).toMatch(/owner_call_shape/);
  });

  it('given a sent row, when it moves to landed without a tx hash, then the shape check refuses', async () => {
    const row = await rowIn('sent');
    expect(await refusalOf(set(row.id, { state: 'landed' }))).toMatch(/owner_call_shape/);
  });

  it('given a landed row inserted with a tx hash and no calls id, then the shape check refuses', async () => {
    const { id: _id, ...rest } = await open(await newConnection());
    const insert = getDb()
      .insert(ownerCalls)
      .values({ ...rest, id: 'oc_shape00000000000000000', idempotencyKey: 'shape', state: 'landed', txHash: '0xtx' });
    expect(await refusalOf(insert)).toMatch(/owner_call_shape/);
  });
});

describe('the purge of approvals never completed', () => {
  it('given a stale pending connection holding an owner call, when the purge runs, then it stays', async () => {
    const stale = {
      status: 'pending',
      ticketHash: randomUUID(),
      grantId: null,
      activatedAt: null,
      expiresAt: new Date(Date.now() - 2 * 86_400_000),
    } as const;
    const withCall = await newConnection(stale);
    const bare = await newConnection({ ...stale, ticketHash: randomUUID() });
    const row = await open(withCall);

    await purge();

    expect((await rowOf(row.id)).state).toBe('awaiting_owner');
    const left = (await getDb().select({ id: connections.id }).from(connections)).map((c) => c.id);
    expect(left).toContain(withCall);
    expect(left).not.toContain(bare);
  });
});

describe('the session lease', () => {
  const lease = async (id: string) => (await rowOf(id)).sessionUntil;

  it('given a new row, then its lease is already live', async () => {
    const row = await open(await newConnection());
    expect((await lease(row.id))!.getTime()).toBeGreaterThan(Date.now());
  });

  it('given a live lease, then the link does not reopen and keeps its url', async () => {
    const row = await open(await newConnection());
    expect(await reopenLink(row, URL_B)).toBeUndefined();
    expect((await rowOf(row.id)).walletUrl).toBe(URL_A);
  });

  it.each([
    ['no lease', null],
    ['a lapsed lease', sql`statement_timestamp() - interval '1 second'`],
  ])('given %s, then the link reopens and takes a live lease', async (_, sessionUntil) => {
    const row = await open(await newConnection());
    await setLease(row.id, sessionUntil);
    const reopened = await reopenLink(row, URL_B);
    expect(reopened).toMatchObject({ walletUrl: URL_B });
    expect(reopened!.sessionUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('given two reopens racing on a lapsed lease, then one wins', async () => {
    const row = await open(await newConnection());
    await lapseLease(row.id);
    const wins = await Promise.all([reopenLink(row, URL_B), reopenLink(row, 'https://keys.test/cli-bridge#c')]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('given a live row, when its session renews, then the lease moves forward', async () => {
    const row = await open(await newConnection());
    await setLease(row.id, sql`statement_timestamp() + interval '1 second'`);
    const before = (await lease(row.id))!.getTime();
    expect((await renewSession(row))!.sessionUntil!.getTime()).toBeGreaterThan(before + 5_000);
  });

  it('given a session that ends, then the lease clears', async () => {
    const row = await open(await newConnection());
    await endSession(row);
    expect(await lease(row.id)).toBeNull();
  });

  it.each(['renewSession', 'endSession'] as const)(
    'given another process took the url, when %s runs for the old one, then the lease is untouched',
    async (call) => {
      const row = await open(await newConnection());
      await lapseLease(row.id);
      const taken = await reopenLink(row, URL_B);
      await { renewSession, endSession }[call](row);
      expect((await rowOf(row.id)).sessionUntil).toEqual(taken!.sessionUntil);
    }
  );

  it.each(['expired', 'owner_declined', 'sent'] as const)(
    'given a %s row, then renewSession writes nothing',
    async (state) => {
      const row = await rowIn(state);
      expect(await renewSession(row)).toBeUndefined();
    }
  );

  describe('the guard', () => {
    it('given a live lease, when the wallet url is rewritten, then the database refuses', async () => {
      const row = await open(await newConnection());
      expect(await refusalOf(set(row.id, { walletUrl: URL_B }))).toMatch(/written once/);
    });

    it('given a lapsed lease, when the wallet url is rewritten, then it is accepted', async () => {
      const row = await open(await newConnection());
      await lapseLease(row.id);
      expect(await refusalOf(set(row.id, { walletUrl: URL_B }))).toBe('written');
    });

    it('given a live lease, when only the lease changes, then it is accepted', async () => {
      const row = await open(await newConnection());
      expect(await refusalOf(setLease(row.id, null))).toBe('written');
    });
  });
});
