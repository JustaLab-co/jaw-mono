import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getAddress } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { connections, payments, swaps } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { claim as claimPayment } from '@/payments/store';
import {
  claimSwap,
  isDepositAddressTaken,
  move,
  nextAttempt,
  recordCallsId,
  writeHeld,
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

beforeAll(async () => {
  if (TEST_PG_URL) await useTestPostgres();
  else await useTestDb();
});

async function newConnection(): Promise<string> {
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
    });
  return id;
}

const freshAddress = () => getAddress(`0x${randomBytes(20).toString('hex')}`);

function quoteOf(address = freshAddress()) {
  return {
    quoteId: `aurora:${address}`,
    depositAddress: address,
    quote: { inputAmount: '1000000', expectedOutputAmount: '990000', minOutputAmount: '980000' },
    quoteFenced: '<<fenced quote>>',
    call: { chainId: 8453, to: USDC, data: '0xa9059cbb', value: '0' },
    paidAt: new Date(),
  };
}

async function quoting(connectionId: string, key: string = randomUUID()) {
  const claimed = await claimSwap(connectionId, key, request);
  if (claimed.kind !== 'run') throw new Error(`claimed ${claimed.kind}`);
  return claimed;
}

async function awaiting(connectionId: string, approveBy = sql`now() + interval '4 minutes'`) {
  const { row, token } = await quoting(connectionId);
  const held = await writeHeld(row.id, token, {
    ...quoteOf(),
    state: 'awaiting_owner',
    walletUrl: 'https://keys.test/cli-bridge#s',
    approveBy,
  });
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

async function paymentFor(row: SwapRow) {
  const claimed = await claimPayment(
    { connectionId: row.connectionId, payer: ACCOUNT, permissionId: 'perm' },
    row.paymentKey,
    { url: 'http://backend.test/proxy/v2/swap/quote', method: 'GET', headers: {} }
  );
  if (claimed.kind !== 'run') throw new Error(`payment ${claimed.kind}`);
  return claimed.row.id;
}

const failPayment = (id: string) =>
  getDb()
    .update(payments)
    .set({ state: 'failed', kind: 'failed', code: 'budget_exhausted', finishedAt: new Date() })
    .where(eq(payments.id, id));

const signPayment = (id: string) =>
  getDb()
    .update(payments)
    .set({
      state: 'signed',
      nonce: `0x${randomBytes(32).toString('hex')}`,
      authorization: { resource: 'quote' },
      authorized: '5000',
      deadline: sql`now() + interval '10 minutes'`,
      signedAt: new Date(),
    })
    .where(eq(payments.id, id));

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
    expect(await writeHeld(first.row.id, first.token, { code: 'late' })).toBeUndefined();
    expect((await rowOf(first.row.id)).code).toBeNull();
  });

  it('given a row for the key, when it is claimed with another input, then it is a conflict', async () => {
    const connectionId = await newConnection();
    await quoting(connectionId, 'k');
    expect((await claimSwap(connectionId, 'k', { ...request, amount: '2000000' })).kind).toBe('conflict');
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

  it('given a quoting swap with a lapsed lease and nothing signed, when another key is claimed, then it is abandoned and the new key runs', async () => {
    const connectionId = await newConnection();
    const old = await quoting(connectionId);
    await paymentFor(old.row);
    await lapse(old.row.id);
    expect((await claimSwap(connectionId, 'other', request)).kind).toBe('run');
    expect(await rowOf(old.row.id)).toMatchObject({ state: 'abandoned', finishedAt: expect.any(Date) });
  });

  it('given a quoting swap with a lapsed lease whose quote payment was signed, when another key is claimed, then it stays open', async () => {
    const connectionId = await newConnection();
    const old = await quoting(connectionId);
    await signPayment(await paymentFor(old.row));
    await lapse(old.row.id);
    expect(await claimSwap(connectionId, 'other', request)).toMatchObject({ kind: 'open', row: { id: old.row.id } });
    expect((await rowOf(old.row.id)).state).toBe('quoting');
  });

  it('given a swap that ended, when another key is claimed, then the new key runs', async () => {
    const connectionId = await newConnection();
    const { row, token } = await quoting(connectionId);
    await writeHeld(row.id, token, { state: 'quote_failed', code: 'quote_unavailable' });
    expect((await claimSwap(connectionId, 'other', request)).kind).toBe('run');
  });
});

describe('payment attempts', () => {
  it('given the current payment is still pending, when a new attempt is asked, then the row keeps its attempt', async () => {
    const { row, token } = await quoting(await newConnection());
    await paymentFor(row);
    expect(await nextAttempt(row.id, token)).toBeUndefined();
    expect((await rowOf(row.id)).paymentAttempt).toBe(1);
  });

  it('given the current payment failed unpaid, when a new attempt is asked, then the row moves to attempt 2 under swap:<id>:2', async () => {
    const { row, token } = await quoting(await newConnection());
    await writeHeld(row.id, token, { paymentId: await paymentFor(row), code: 'budget_exhausted' });
    await failPayment((await rowOf(row.id)).paymentId!);
    const next = await nextAttempt(row.id, token);
    expect(next).toMatchObject({ paymentAttempt: 2, paymentKey: `swap:${row.id}:2`, paymentId: null, code: null });
  });

  it('given a row holding a quote whose payment later failed, when a new attempt is asked, then the row keeps its attempt', async () => {
    const { row, token } = await quoting(await newConnection());
    await failPayment(await paymentFor(row));
    await writeHeld(row.id, token, quoteOf());
    expect(await nextAttempt(row.id, token)).toBeUndefined();
    expect((await rowOf(row.id)).paymentAttempt).toBe(1);
  });

  it('given a quoting row, when the attempt skips a number or the key does not follow it, then the database refuses', async () => {
    const { row } = await quoting(await newConnection());
    const write = (set: Partial<SwapRow>) => refusalOf(getDb().update(swaps).set(set).where(eq(swaps.id, row.id)));
    expect(await write({ paymentAttempt: 3, paymentKey: `swap:${row.id}:3` })).toMatch(/grows by one/);
    expect(await write({ paymentAttempt: 2, paymentKey: `swap:${row.id}:1` })).toMatch(/swap_payment_key/);
    expect(await write({ paymentKey: `swap:${row.id}:2` })).toMatch(/swap_payment_key/);
  });

  it('given a row holding a quote, when the attempt grows, then the database refuses', async () => {
    const { row, token } = await quoting(await newConnection());
    await writeHeld(row.id, token, quoteOf());
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
      return (await writeHeld(row.id, token, { state }))!;
    }
    const row = await awaiting(connectionId);
    if (state === 'awaiting_owner') return row;
    if (['owner_declined', 'expired'].includes(state)) return (await move(row.id, ['awaiting_owner'], state))!;
    const sent = (await recordCallsId(row.id, '0xcalls'))!;
    if (state === 'deposit_sent') return sent;
    const submitted = (await move(row.id, ['deposit_sent'], 'submitted'))!;
    if (state === 'submitted') return submitted;
    return (await move(row.id, ['submitted'], state))!;
  }

  const illegal: [SwapRow['state'], SwapRow['state']][] = [
    ['quoting', 'deposit_sent'],
    ['quoting', 'expired'],
    ['quoting', 'completed'],
    ['awaiting_owner', 'quoting'],
    ['expired', 'awaiting_owner'],
    ['expired', 'owner_declined'],
    ['deposit_sent', 'completed'],
    ['deposit_sent', 'expired'],
    ['submitted', 'deposit_sent'],
    ['quote_failed', 'quoting'],
    ['abandoned', 'awaiting_owner'],
    ['owner_declined', 'deposit_sent'],
    ['completed', 'failed'],
    ['refunded', 'submitted'],
  ];

  it.each(illegal)('given a %s row, when it is moved to %s, then the database refuses', async (from, to) => {
    const row = await rowIn(from);
    const write = getDb().update(swaps).set({ state: to, callsId: '0xcalls' }).where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/is not a transition|and final/);
    expect((await rowOf(row.id)).state).toBe(from);
  });

  it('given a swap, when it runs from quote to completed, then each step lands and only the last one finishes it', async () => {
    const row = await awaiting(await newConnection());
    expect((await recordCallsId(row.id, '0xcalls'))?.finishedAt).toBeNull();
    expect((await move(row.id, ['deposit_sent'], 'submitted'))?.finishedAt).toBeNull();
    expect(await move(row.id, ['submitted'], 'completed')).toMatchObject({
      state: 'completed',
      callsId: '0xcalls',
      finishedAt: expect.any(Date),
    });
  });

  it('given an awaiting_owner row, when the backend already shows the deposit, then it moves straight to submitted', async () => {
    const row = await awaiting(await newConnection());
    expect((await move(row.id, ['awaiting_owner', 'expired'], 'submitted'))?.state).toBe('submitted');
  });

  it('given a row that expired, when the wallet answers a calls id, then it moves to deposit_sent (B33)', async () => {
    const row = await rowIn('expired');
    expect(await recordCallsId(row.id, '0xlate')).toMatchObject({ state: 'deposit_sent', callsId: '0xlate' });
  });

  it('given a row that expired, when it moves to deposit_sent with no calls id, then the database refuses', async () => {
    const row = await rowIn('expired');
    const write = getDb().update(swaps).set({ state: 'deposit_sent' }).where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/only with a calls id/);
  });

  it('given a row in a final state, when a calls id arrives, then nothing is written', async () => {
    const row = await rowIn('owner_declined');
    expect(await recordCallsId(row.id, '0xcalls')).toBeUndefined();
    expect((await rowOf(row.id)).state).toBe('owner_declined');
  });

  it('given a completed row, when anything on it is rewritten, then the database refuses', async () => {
    const row = await rowIn('completed');
    const write = getDb().update(swaps).set({ backendState: 'FAILED' }).where(eq(swaps.id, row.id));
    expect(await refusalOf(write)).toMatch(/is completed and final/);
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
    ['paid at', { paidAt: new Date(0) }],
  ])('given an awaiting_owner row, when its %s is rewritten, then the database refuses', async (_, set) => {
    const row = await rowIn('awaiting_owner');
    expect(await refusalOf(getDb().update(swaps).set(set).where(eq(swaps.id, row.id)))).toMatch(
      /the quote is written once/
    );
  });

  it('given a quoting row, when it moves to awaiting_owner without a link, then the database refuses', async () => {
    const { row, token } = await quoting(await newConnection());
    expect(await refusalOf(writeHeld(row.id, token, { ...quoteOf(), state: 'awaiting_owner' }))).toMatch(/swap_shape/);
  });
});

describe('deposit addresses', () => {
  it('given a swap holding a deposit address, when another swap writes it in another case, then the database refuses', async () => {
    const address = freshAddress();
    const first = await quoting(await newConnection());
    await writeHeld(first.row.id, first.token, quoteOf(address));
    const second = await quoting(await newConnection());
    const write = writeHeld(second.row.id, second.token, {
      ...quoteOf(),
      depositAddress: address.toLowerCase(),
    });
    expect(await refusalOf(write)).toMatch(/swaps_deposit_address_index/);
  });

  it('given a swap holding a deposit address, when it is looked up in any case, then it is taken', async () => {
    const address = freshAddress();
    const { row, token } = await quoting(await newConnection());
    await writeHeld(row.id, token, quoteOf(address));
    expect(await isDepositAddressTaken(address.toLowerCase())).toBe(true);
    expect(await isDepositAddressTaken(address.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(await isDepositAddressTaken(freshAddress())).toBe(false);
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
