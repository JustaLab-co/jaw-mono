import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { getAddress } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, swaps } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { purge } from '@/reconciler/run';
import {
  claimSwap,
  quoteReused,
  move,
  markSendStarted,
  recordCallsId,
  release,
  renewSession,
  endSession,
  reopenLink,
  SEND_STARTED,
  SWAP_TRANSITIONS,
  writeHeld,
  type SwapLease,
  type SwapRequest,
  type SwapRow,
} from './store';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const request: SwapRequest = {
  originChainId: 8453,
  originToken: USDC,
  destinationChainId: 42161,
  destinationToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  amount: '1000000',
  depositor: ACCOUNT,
  recipient: ACCOUNT,
};

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
      scopes: ['x402:pay'],
      interactionUid: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      grantId: randomUUID(),
      activatedAt: new Date(),
      ...over,
    });
  return id;
}

const stalePending = () =>
  newConnection({
    status: 'pending',
    ticketHash: randomUUID(),
    grantId: null,
    activatedAt: null,
    expiresAt: new Date(Date.now() - 2 * 86_400_000),
  });

const freshAddress = () => getAddress(`0x${randomBytes(20).toString('hex')}`);

function quoteOf(address = freshAddress()) {
  return {
    quoteId: `aurora:${address}`,
    depositAddress: address,
    quote: { inputAmount: '1000000', expectedOutputAmount: '990000', minOutputAmount: '980000' },
    quoteFenced: '<<fenced quote>>',
    call: { chainId: 8453, to: USDC, data: '0xa9059cbb', value: '0' },
    quotedAt: new Date(),
  };
}

async function quoting(connectionId: string, key: string = randomUUID()) {
  const claimed = await claimSwap(connectionId, key, request);
  if (claimed.kind !== 'run') throw new Error(`claimed ${claimed.kind}`);
  return claimed;
}

const leaseOf = (row: SwapRow, token: string): SwapLease => ({ connectionId: row.connectionId, id: row.id, token });

const linkOf = (approveBy: SQL = sql`now() + interval '4 minutes'`) => ({
  ...quoteOf(),
  walletUrl: 'https://keys.test/cli-bridge#s',
  approveBy,
  leaseHolder: 'the run that opened the link',
});

async function awaiting(connectionId: string, approveBy?: SQL) {
  const { row, token } = await quoting(connectionId);
  const held = await writeHeld(leaseOf(row, token), { ...linkOf(approveBy), state: 'awaiting_owner' });
  if (!held) throw new Error('the quote was not written');
  return held;
}

const rowOf = async (id: string): Promise<SwapRow> => (await getDb().select().from(swaps).where(eq(swaps.id, id)))[0];

const lapse = (id: string) =>
  getDb()
    .update(swaps)
    .set({ leaseUntil: sql`now() - interval '1 second'` })
    .where(eq(swaps.id, id));

const refusalOf = (write: Promise<unknown>) =>
  write.then(
    () => 'written',
    (e: Error & { cause?: Error }) => e.cause?.message ?? e.message
  );

describe('claiming a swap by its idempotency key', () => {
  it('given a new key, when it is claimed, then the row is quoting on attempt 1 under the key swap:<id>:1', async () => {
    const { row } = await quoting(await newConnection(), 'agent-key');
    expect(row).toMatchObject({ state: 'quoting', paymentAttempt: 1, idempotencyKey: 'agent-key' });
    expect(row.paymentKey).toBe(`swap:${row.id}:1`);
  });

  it('given a quoting row held by a live call, when the same key is claimed, then it is busy', async () => {
    const connectionId = await newConnection();
    await quoting(connectionId, 'k');
    expect((await claimSwap(connectionId, 'k', request)).kind).toBe('busy');
  });

  it('given a quoting row whose lease lapsed, when the same key is claimed, then the call takes the row over', async () => {
    const connectionId = await newConnection();
    const first = await quoting(connectionId, 'k');
    await lapse(first.row.id);
    const again = await claimSwap(connectionId, 'k', request);
    expect(again).toMatchObject({ kind: 'run', row: { id: first.row.id } });
    expect(await writeHeld(leaseOf(first.row, first.token), { code: 'late' })).toBeUndefined();
    expect((await rowOf(first.row.id)).code).toBeNull();
  });

  it('given a row for the key, when it is claimed with another input, then it is a conflict', async () => {
    const connectionId = await newConnection();
    await quoting(connectionId, 'k');
    expect((await claimSwap(connectionId, 'k', { ...request, amount: '2000000' })).kind).toBe('conflict');
  });

  it('given a row for the key, when it is claimed with the same addresses in another case, then it is the same request', async () => {
    const connectionId = await newConnection();
    await quoting(connectionId, 'k');
    const checksummed = {
      ...request,
      originToken: getAddress(request.originToken),
      destinationToken: getAddress(request.destinationToken),
      depositor: ACCOUNT.toUpperCase().replace('0X', '0x'),
    };
    expect((await claimSwap(connectionId, 'k', checksummed)).kind).toBe('busy');
  });

  it('given a row past quoting, when the same key is claimed, then the stored row answers', async () => {
    const connectionId = await newConnection();
    const row = await awaiting(connectionId);
    expect(await claimSwap(connectionId, row.idempotencyKey, request)).toEqual({ kind: 'stored', row });
  });
});

describe('one open swap per connection (B18)', () => {
  it('given a quoting swap held by a live call, when another key is claimed, then it names the open swap and inserts nothing', async () => {
    const connectionId = await newConnection();
    const open = await quoting(connectionId);
    const other = await claimSwap(connectionId, 'other', request);
    expect(other).toMatchObject({ kind: 'open', row: { id: open.row.id } });
    expect(await getDb().select().from(swaps).where(eq(swaps.connectionId, connectionId))).toHaveLength(1);
  });

  it('given an awaiting_owner swap before approve_by, when another key is claimed, then it names the open swap', async () => {
    const connectionId = await newConnection();
    const open = await awaiting(connectionId);
    expect(await claimSwap(connectionId, 'other', request)).toMatchObject({ kind: 'open', row: { id: open.id } });
  });

  it('given an awaiting_owner swap past approve_by, when another key is claimed, then the old one expires and the new key runs', async () => {
    const connectionId = await newConnection();
    const old = await awaiting(connectionId, sql`now() - interval '1 second'`);
    expect((await claimSwap(connectionId, 'other', request)).kind).toBe('run');
    expect((await rowOf(old.id)).state).toBe('expired');
  });

  it('given a quoting swap with a lapsed lease and no quote, when another key is claimed, then it is abandoned and the new key runs', async () => {
    const connectionId = await newConnection();
    const old = await quoting(connectionId);
    await lapse(old.row.id);
    expect((await claimSwap(connectionId, 'other', request)).kind).toBe('run');
    expect(await rowOf(old.row.id)).toMatchObject({ state: 'abandoned', finishedAt: expect.any(Date) });
  });

  it('given a quoting swap with a lapsed lease holding a quote inside its owner window, when another key is claimed, then it stays open', async () => {
    const connectionId = await newConnection();
    const old = await quoting(connectionId);
    await writeHeld(leaseOf(old.row, old.token), quoteOf());
    await lapse(old.row.id);
    expect(await claimSwap(connectionId, 'other', request)).toMatchObject({ kind: 'open', row: { id: old.row.id } });
    expect((await rowOf(old.row.id)).state).toBe('quoting');
  });

  it('given a swap that ended, when another key is claimed, then the new key runs', async () => {
    const connectionId = await newConnection();
    const { row, token } = await quoting(connectionId);
    await writeHeld(leaseOf(row, token), { state: 'quote_failed', code: 'quote_unavailable' });
    expect((await claimSwap(connectionId, 'other', request)).kind).toBe('run');
  });
});

describe('a claim that keeps losing the open-swap slot', () => {
  const churn = [
    sql.raw(`
    create function churn() returns trigger language plpgsql as $$
    declare id text := 'swp_churn_' || md5(random()::text);
    begin
      if new.idempotency_key = 'churned' then
        insert into swaps (id, connection_id, idempotency_key, request_hash, payment_key, lease_until,
          origin_chain_id, origin_token, destination_chain_id, destination_token, amount, depositor, recipient)
        values (id, new.connection_id, id, new.request_hash, 'swap:' || id || ':1', now() - interval '1 second',
          new.origin_chain_id, new.origin_token, new.destination_chain_id, new.destination_token, new.amount,
          new.depositor, new.recipient);
      end if;
      return new;
    end $$`),
    sql.raw('create trigger churn before insert on swaps for each row execute function churn()'),
  ];
  const calm = [sql.raw('drop trigger churn on swaps'), sql.raw('drop function churn()')];
  const run = async (statements: SQL[]) => {
    for (const s of statements) await getDb().execute(s);
  };

  it('given another swap takes the slot before every insert and frees it right after, when the key is claimed, then it is busy and nothing is written for it', async () => {
    const connectionId = await newConnection();
    await run(churn);
    try {
      expect(await claimSwap(connectionId, 'churned', request)).toEqual({ kind: 'busy' });
    } finally {
      await run(calm);
    }
    const rows = await getDb().select().from(swaps).where(eq(swaps.connectionId, connectionId));
    expect(rows.filter((r) => r.idempotencyKey === 'churned')).toEqual([]);
    expect(rows.every((r) => r.state === 'abandoned')).toBe(true);
    expect((await claimSwap(connectionId, 'churned', request)).kind).toBe('run');
  });
});

describe('the purge of approvals never completed', () => {
  it('given a stale pending connection holding a swap, when the purge runs, then the swap and its connection stay and the rest is purged', async () => {
    const withSwap = await stalePending();
    const bare = await stalePending();
    const { row } = await quoting(withSwap);

    await purge();

    expect((await rowOf(row.id)).state).toBe('quoting');
    const left = await getDb().select({ id: connections.id }).from(connections);
    expect(left.map((c) => c.id)).toContain(withSwap);
    expect(left.map((c) => c.id)).not.toContain(bare);
  });
});

describe('lease writes', () => {
  it('given a lease of another connection, when the row is written or released, then nothing changes', async () => {
    const { row, token } = await quoting(await newConnection());
    const foreign = { ...leaseOf(row, token), connectionId: await newConnection() };

    expect(await writeHeld(foreign, { code: 'foreign' })).toBeUndefined();
    expect(await release(foreign, { code: 'foreign' })).toBeUndefined();
    expect(await rowOf(row.id)).toMatchObject({ code: null, leaseToken: token });
  });

  it('given a row holding its quote, when the lease is released, then the row keeps its quote and its lease', async () => {
    const { row, token } = await quoting(await newConnection());
    await writeHeld(leaseOf(row, token), quoteOf());

    expect(await release(leaseOf(row, token), { code: 'late' })).toBeUndefined();
    expect(await rowOf(row.id)).toMatchObject({ code: null, leaseToken: token });
  });
});

describe('the payment attempt columns', () => {
  it('given a quoting row, when the attempt skips a number or the key does not follow it, then the database refuses', async () => {
    const { row } = await quoting(await newConnection());
    const write = (set: Partial<SwapRow>) => refusalOf(getDb().update(swaps).set(set).where(eq(swaps.id, row.id)));
    expect(await write({ paymentAttempt: 3, paymentKey: `swap:${row.id}:3` })).toMatch(/grows by one/);
    expect(await write({ paymentAttempt: 2, paymentKey: `swap:${row.id}:1` })).toMatch(/swap_payment_key/);
    expect(await write({ paymentKey: `swap:${row.id}:2` })).toMatch(/swap_payment_key/);
  });

  it('given a quoting row with no quote, when the attempt grows in the same write that sets a quote id, then the database refuses', async () => {
    const { row } = await quoting(await newConnection());
    const write = getDb()
      .update(swaps)
      .set({ paymentAttempt: 2, paymentKey: `swap:${row.id}:2`, quoteId: `aurora:${freshAddress()}` })
      .where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/grows by one/);
    expect((await rowOf(row.id)).quoteId).toBeNull();
  });

  it('given a row holding a quote, when the attempt grows, then the database refuses', async () => {
    const { row, token } = await quoting(await newConnection());
    await writeHeld(leaseOf(row, token), quoteOf());
    const write = getDb()
      .update(swaps)
      .set({ paymentAttempt: 2, paymentKey: `swap:${row.id}:2` })
      .where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/grows by one/);
  });

  it('given a row awaiting the owner, when the attempt grows, then the database refuses', async () => {
    const row = await awaiting(await newConnection());
    const write = getDb()
      .update(swaps)
      .set({ paymentAttempt: 2, paymentKey: `swap:${row.id}:2` })
      .where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/grows by one/);
  });
});

describe('the swaps guard', () => {
  async function rowIn(state: SwapRow['state']): Promise<SwapRow> {
    const connectionId = await newConnection();
    if (state === 'quoting') return (await quoting(connectionId)).row;
    if (['quote_failed', 'quote_rejected', 'abandoned'].includes(state)) {
      const { row, token } = await quoting(connectionId);
      return (await writeHeld(leaseOf(row, token), { state }))!;
    }
    const row = await awaiting(connectionId);
    if (state === 'awaiting_owner') return row;
    if (['owner_declined', 'expired'].includes(state)) {
      return (await move(connectionId, row.id, ['awaiting_owner'], state))!;
    }
    const sent = (await recordCallsId(row, '0xcalls'))!;
    if (state === 'deposit_sent') return sent;
    const submitted = (await move(connectionId, row.id, ['deposit_sent'], 'submitted'))!;
    if (state === 'submitted') return submitted;
    return (await move(connectionId, row.id, ['submitted'], state))!;
  }

  const states = swaps.state.enumValues;
  const pairs = states.flatMap((from) => states.filter((to) => to !== from).map((to) => [from, to] as const));
  const listed = (from: string, to: string) => SWAP_TRANSITIONS.some(([f, t]) => f === from && t === to);

  it.each(pairs)(
    'given a %s row, when it is moved to %s, then the database takes it only if the transition is listed',
    async (from, to) => {
      const row = await rowIn(from);
      const quote = from === 'quoting' ? linkOf() : {};
      const write = getDb()
        .update(swaps)
        .set({ ...quote, state: to, callsId: '0xcalls' })
        .where(eq(swaps.id, row.id));
      if (listed(from, to)) {
        expect(await refusalOf(write)).toBe('written');
        expect((await rowOf(row.id)).state).toBe(to);
        return;
      }
      expect(await refusalOf(write)).toMatch(/is not a transition|and final/);
      expect((await rowOf(row.id)).state).toBe(from);
    }
  );

  it('given a swap, when it runs from quote to completed, then each step lands and only the last one finishes it', async () => {
    const connectionId = await newConnection();
    const row = await awaiting(connectionId);
    expect((await recordCallsId(row, '0xcalls'))?.finishedAt).toBeNull();
    expect((await move(connectionId, row.id, ['deposit_sent'], 'submitted'))?.finishedAt).toBeNull();
    expect(await move(connectionId, row.id, ['submitted'], 'completed')).toMatchObject({
      state: 'completed',
      callsId: '0xcalls',
      finishedAt: expect.any(Date),
    });
  });

  it('given an awaiting_owner row, when the backend already shows the deposit, then it moves straight to submitted', async () => {
    const connectionId = await newConnection();
    const row = await awaiting(connectionId);
    expect((await move(connectionId, row.id, ['awaiting_owner', 'expired'], 'submitted'))?.state).toBe('submitted');
  });

  it('given a swap of another connection, when it is moved or given a calls id, then nothing is written', async () => {
    const row = await rowIn('awaiting_owner');
    const stranger = await newConnection();
    expect(await move(stranger, row.id, ['awaiting_owner'], 'owner_declined')).toBeUndefined();
    expect(await recordCallsId({ ...row, connectionId: stranger }, '0xcalls')).toBeUndefined();
    expect(await rowOf(row.id)).toMatchObject({ state: 'awaiting_owner', callsId: null });
  });

  it('given a swap, when a write outside the store ends it, then the database stamps updated_at and finished_at', async () => {
    const row = await rowIn('awaiting_owner');
    const [declined] = await getDb()
      .update(swaps)
      .set({ state: 'owner_declined', updatedAt: new Date(0) })
      .where(eq(swaps.id, row.id))
      .returning();
    expect(declined.updatedAt.getTime()).toBeGreaterThan(0);
    expect(declined.finishedAt).toEqual(declined.updatedAt);
  });

  it('given a row that expired, when the wallet answers a calls id, then it moves to deposit_sent (B33)', async () => {
    const row = await rowIn('expired');
    expect(await recordCallsId(row, '0xlate')).toMatchObject({
      state: 'deposit_sent',
      callsId: '0xlate',
    });
  });

  it.each(['awaiting_owner', 'expired'] as const)(
    'given a %s row, when it moves to deposit_sent with no calls id, then the database refuses',
    async (from) => {
      const row = await rowIn(from);
      const write = getDb().update(swaps).set({ state: 'deposit_sent' }).where(eq(swaps.id, row.id));
      expect(await refusalOf(write)).toMatch(/only with a calls id/);
    }
  );

  it('given a row in a final state, when a calls id arrives, then nothing is written', async () => {
    const row = await rowIn('owner_declined');
    expect(await recordCallsId(row, '0xcalls')).toBeUndefined();
    expect((await rowOf(row.id)).state).toBe('owner_declined');
  });

  const finals = states.filter((s) => !SWAP_TRANSITIONS.some(([from]) => from === s));

  it.each(finals)('given a %s row, then it is finished and anything rewritten on it is refused', async (state) => {
    const row = await rowIn(state);
    expect(row.finishedAt).toEqual(expect.any(Date));
    const write = getDb().update(swaps).set({ backendState: 'FAILED' }).where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(new RegExp(`is ${state} and final`));
  });

  it.each(states.filter((s) => !finals.includes(s)))('given a %s row, then it is not finished', async (state) => {
    expect((await rowIn(state)).finishedAt).toBeNull();
  });

  it('given any swap, when it is deleted, then the database refuses', async () => {
    const row = await rowIn('quoting');
    expect(await refusalOf(getDb().delete(swaps).where(eq(swaps.id, row.id)))).toMatch(/never deleted/);
  });

  it.each([
    ['amount', { amount: '1' }],
    ['recipient', { recipient: '0x2222222222222222222222222222222222222222' }],
    ['destination chain', { destinationChainId: 10 }],
    ['request hash', { requestHash: 'other' }],
  ])('given a quoting row, when its %s changes, then the database refuses', async (_, set) => {
    const row = await rowIn('quoting');
    expect(await refusalOf(getDb().update(swaps).set(set).where(eq(swaps.id, row.id)))).toMatch(
      /the request is immutable/
    );
  });

  it.each([
    ['call', { call: { chainId: 8453, to: USDC, data: '0xdeadbeef', value: '0' } }],
    ['quote id', { quoteId: null }],
    ['deposit address', { depositAddress: freshAddress() }],
    ['fenced quote', { quoteFenced: 'other' }],
    ['paid at', { quotedAt: new Date(0) }],
    ['approve by', { approveBy: new Date(0) }],
    ['quote', { quote: { inputAmount: '1' } }],
  ])('given an awaiting_owner row, when its %s is rewritten, then the database refuses', async (_, set) => {
    const row = await rowIn('awaiting_owner');
    expect(await refusalOf(getDb().update(swaps).set(set).where(eq(swaps.id, row.id)))).toMatch(/are written once/);
  });

  it.each([
    ['awaiting_owner row holding the send marker', 'awaiting_owner', { code: SEND_STARTED }],
    ['expired row', 'expired', { code: null }],
  ] as const)('given an %s, when its wallet url is rewritten, then the database refuses', async (_, state, set) => {
    const row = await rowIn(state);
    await getDb().update(swaps).set(set).where(eq(swaps.id, row.id));
    const write = getDb()
      .update(swaps)
      .set({ walletUrl: 'https://keys.test/cli-bridge#other' })
      .where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/are written once/);
  });

  it('given an awaiting_owner row with no send marker, when its wallet url is cleared, then the database refuses', async () => {
    const row = await rowIn('awaiting_owner');
    const write = getDb().update(swaps).set({ walletUrl: null }).where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).not.toBe('written');
  });

  it('given a deposit_sent row, when its calls id is rewritten, then the database refuses', async () => {
    const row = await rowIn('deposit_sent');
    const write = getDb().update(swaps).set({ callsId: '0xother' }).where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/are written once/);
  });

  it('given a quoting row, when it moves to awaiting_owner without a link, then the database refuses', async () => {
    const { row, token } = await quoting(await newConnection());
    expect(await refusalOf(writeHeld(leaseOf(row, token), { ...quoteOf(), state: 'awaiting_owner' }))).toMatch(
      /swap_shape/
    );
  });
});

describe('deposit addresses', () => {
  it('given a swap holding a deposit address, when another swap writes it in another case, then the database refuses', async () => {
    const address = freshAddress();
    const first = await quoting(await newConnection());
    await writeHeld(leaseOf(first.row, first.token), quoteOf(address));
    const second = await quoting(await newConnection());
    const write = writeHeld(leaseOf(second.row, second.token), {
      ...quoteOf(),
      depositAddress: address.toLowerCase(),
    });
    expect(await refusalOf(write)).toMatch(/swaps_deposit_address_index/);
  });

  it('given a write refused by the deposit address index or by another unique key, when it is read, then only the first is a reused address', async () => {
    const address = freshAddress();
    const first = await quoting(await newConnection());
    await writeHeld(leaseOf(first.row, first.token), quoteOf(address));
    const second = await quoting(await newConnection());
    const reused = await writeHeld(leaseOf(second.row, second.token), {
      ...quoteOf(),
      depositAddress: address,
    }).catch((e: unknown) => e);
    const duplicate = await getDb()
      .insert(swaps)
      .values(first.row)
      .catch((e: unknown) => e);

    expect(quoteReused(reused)).toBe(true);
    expect(quoteReused(duplicate)).toBe(false);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, claims racing for the open-swap slot (B19)', () => {
  it('given no open swap, when eight keys are claimed at once, then one runs and the rest name it', async () => {
    for (let round = 0; round < 5; round++) {
      const connectionId = await newConnection();
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) => claimSwap(connectionId, `key-${i}`, request))
      );
      const runs = claims.filter((c) => c.kind === 'run');
      expect(runs).toHaveLength(1);
      const winner = runs[0].kind === 'run' && runs[0].row.id;
      for (const c of claims.filter((c) => c.kind !== 'run')) {
        expect(c).toMatchObject({ kind: 'open', row: { id: winner } });
      }
      expect(await getDb().select().from(swaps).where(eq(swaps.connectionId, connectionId))).toHaveLength(1);
    }
  });

  it('given no swap for a key, when the same request claims it twice at once, then one runs and the other is busy', async () => {
    for (let round = 0; round < 5; round++) {
      const connectionId = await newConnection();
      const claims = await Promise.all([claimSwap(connectionId, 'k', request), claimSwap(connectionId, 'k', request)]);
      expect(claims.map((c) => c.kind).sort()).toEqual(['busy', 'run']);
    }
  });

  it('given no swap for a key, when two requests claim it at once, then one runs and the other is a conflict', async () => {
    for (let round = 0; round < 5; round++) {
      const connectionId = await newConnection();
      const claims = await Promise.all([
        claimSwap(connectionId, 'k', request),
        claimSwap(connectionId, 'k', { ...request, amount: '2000000' }),
      ]);
      expect(claims.map((c) => c.kind).sort()).toEqual(['conflict', 'run']);
    }
  });

  it('given an awaiting_owner swap past approve_by, when two keys are claimed at once, then it expires once and one key runs', async () => {
    for (let round = 0; round < 5; round++) {
      const connectionId = await newConnection();
      const old = await awaiting(connectionId, sql`now() - interval '1 second'`);
      const claims = await Promise.all([claimSwap(connectionId, 'a', request), claimSwap(connectionId, 'b', request)]);
      expect(claims.map((c) => c.kind).sort()).toEqual(['open', 'run']);
      expect((await rowOf(old.id)).state).toBe('expired');
    }
  });
});

describe('the send marker and a reopened link', () => {
  it('given an awaiting_owner row before approve_by with no code, when the send starts, then it holds the marker', async () => {
    const row = await awaiting(await newConnection());
    expect(await markSendStarted(row)).toMatchObject({
      state: 'awaiting_owner',
      code: SEND_STARTED,
    });
  });

  it.each([
    ['approve_by has passed', sql`now() - interval '1 second'`, { code: null }],
    ['it holds a wallet error', undefined, { code: 'wallet_error:5710' }],
  ])(
    'given an awaiting_owner row where %s, when the send starts, then no marker is written',
    async (_, approveBy, set) => {
      const row = await awaiting(await newConnection(), approveBy);
      await getDb().update(swaps).set(set).where(eq(swaps.id, row.id));
      expect(await markSendStarted(row)).toBeUndefined();
    }
  );

  it('given the marker this run wrote, when the send starts again, then it passes, and a run that lost the row is refused', async () => {
    const row = await awaiting(await newConnection());
    await markSendStarted(row);
    expect(await markSendStarted(row)).toMatchObject({ code: SEND_STARTED });
    expect(await markSendStarted({ ...row, leaseHolder: 'another process' })).toBeUndefined();
  });

  it('given an expired row, when the send starts, then no marker is written', async () => {
    const row = await awaiting(await newConnection());
    await move(row.connectionId, row.id, ['awaiting_owner'], 'expired');
    expect(await markSendStarted(row)).toBeUndefined();
  });

  it('given a link a relay session can still rejoin, then the table refuses a new url written past the store', async () => {
    const row = await awaiting(await newConnection());
    await getDb().update(swaps).set({ relay: 'r1.kid.iv.sealed' }).where(eq(swaps.id, row.id));
    const write = getDb()
      .update(swaps)
      .set({ walletUrl: 'https://keys.test/cli-bridge#new' })
      .where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/written once/);
  });

  it('given a link a relay session can still rejoin, when it would reopen, then nothing is written', async () => {
    const row = await awaiting(await newConnection());
    await getDb().update(swaps).set({ relay: 'r1.kid.iv.sealed' }).where(eq(swaps.id, row.id));
    expect(await reopenLink(row, 'https://keys.test/cli-bridge#new')).toBeUndefined();
  });

  it('given an awaiting_owner row with a wallet error, when its link reopens, then the new url is written and the code cleared', async () => {
    const row = await awaiting(await newConnection());
    await getDb().update(swaps).set({ code: 'wallet_error:5710' }).where(eq(swaps.id, row.id));
    expect(await reopenLink(row, 'https://keys.test/cli-bridge#new')).toMatchObject({
      state: 'awaiting_owner',
      walletUrl: 'https://keys.test/cli-bridge#new',
      code: null,
    });
  });

  it.each([
    ['it holds the send marker', { code: SEND_STARTED }],
    ['another call reopened it first', { walletUrl: 'https://keys.test/cli-bridge#first' }],
    ['approve_by has passed', { approveBy: sql`now() - interval '1 second'` }],
  ])('given an awaiting_owner row where %s, when its link reopens, then nothing is written', async (_, set) => {
    const row = await awaiting(await newConnection());
    await getDb().execute(sql`alter table swaps disable trigger swaps_guard`);
    await getDb().update(swaps).set(set).where(eq(swaps.id, row.id));
    await getDb().execute(sql`alter table swaps enable trigger swaps_guard`);
    expect(await reopenLink(row, 'https://keys.test/cli-bridge#new')).toBeUndefined();
  });

  it('given a send marker, when the calls id is recorded, then the marker is cleared', async () => {
    const row = await awaiting(await newConnection());
    await markSendStarted(row);
    expect(await recordCallsId(row, '0xcalls')).toMatchObject({
      state: 'deposit_sent',
      code: null,
    });
  });
});

describe('the session lease', () => {
  const lease = async (id: string) => (await rowOf(id)).sessionUntil;
  const setLease = (id: string, sessionUntil: SQL | null) =>
    getDb().update(swaps).set({ sessionUntil }).where(eq(swaps.id, id));
  const lapsed = sql`now() - interval '1 second'`;
  const URL_NEW = 'https://keys.test/cli-bridge#new';

  it('given a live lease, then the link does not reopen and keeps its url', async () => {
    const row = await awaiting(await newConnection());
    await setLease(row.id, sql`now() + interval '30 seconds'`);
    expect(await reopenLink(row, URL_NEW)).toBeUndefined();
    expect((await rowOf(row.id)).walletUrl).toBe(row.walletUrl);
  });

  it.each([
    ['no lease', null],
    ['a lapsed lease', lapsed],
  ])('given %s, then the link reopens and takes a live lease', async (_, sessionUntil) => {
    const row = await awaiting(await newConnection());
    await setLease(row.id, sessionUntil);
    const reopened = await reopenLink(row, URL_NEW);
    expect(reopened).toMatchObject({ walletUrl: URL_NEW });
    expect(reopened!.sessionUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('given two reopens racing on a lapsed lease, then one wins', async () => {
    const row = await awaiting(await newConnection());
    await setLease(row.id, lapsed);
    const wins = await Promise.all([reopenLink(row, URL_NEW), reopenLink(row, 'https://keys.test/cli-bridge#c')]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('given a live row, when its session renews, then the lease moves forward', async () => {
    const row = await awaiting(await newConnection());
    await setLease(row.id, sql`now() + interval '1 second'`);
    const before = (await lease(row.id))!.getTime();
    expect((await renewSession(row))!.sessionUntil!.getTime()).toBeGreaterThan(before + 5_000);
  });

  it('given a session that ends, then the lease clears', async () => {
    const row = await awaiting(await newConnection());
    await setLease(row.id, sql`now() + interval '30 seconds'`);
    await endSession(row);
    expect(await lease(row.id)).toBeNull();
  });

  it.each(['renewSession', 'endSession'] as const)(
    'given another process took the url, when %s runs for the old one, then the lease is untouched',
    async (call) => {
      const row = await awaiting(await newConnection());
      await setLease(row.id, lapsed);
      const taken = await reopenLink(row, URL_NEW);
      await { renewSession, endSession }[call](row);
      expect((await rowOf(row.id)).sessionUntil).toEqual(taken!.sessionUntil);
    }
  );

  it('given an expired row, then renewSession writes nothing', async () => {
    const row = await awaiting(await newConnection());
    await move(row.connectionId, row.id, ['awaiting_owner'], 'expired');
    expect(await renewSession(row)).toBeUndefined();
  });

  describe('the guard', () => {
    it('given a live lease, when the wallet url is rewritten, then the database refuses', async () => {
      const row = await awaiting(await newConnection());
      await setLease(row.id, sql`now() + interval '30 seconds'`);
      const write = getDb().update(swaps).set({ walletUrl: URL_NEW }).where(eq(swaps.id, row.id));
      expect(await refusalOf(write)).toMatch(/written once/);
    });

    it('given a lapsed lease, when the wallet url is rewritten, then it is accepted', async () => {
      const row = await awaiting(await newConnection());
      await setLease(row.id, lapsed);
      const write = getDb().update(swaps).set({ walletUrl: URL_NEW }).where(eq(swaps.id, row.id));
      expect(await refusalOf(write)).toBe('written');
    });

    it('given a live lease, when only the lease changes, then it is accepted', async () => {
      const row = await awaiting(await newConnection());
      await setLease(row.id, sql`now() + interval '30 seconds'`);
      expect(await refusalOf(setLease(row.id, null))).toBe('written');
    });
  });
});
