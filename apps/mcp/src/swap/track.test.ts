import { randomBytes, randomUUID } from 'node:crypto';
import type { ChainClients } from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, pad, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, swaps } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import type { BackendDeps } from './backend';
import { DEPOSIT_REVERTED, type SwapRow, type SwapState } from './store';
import { submit, track } from './track';

setTestEnv();
beforeAll(useTestDb);

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPOKE_POOL: Address = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const TX: Hex = `0x${'ab'.repeat(32)}`;
const OTHER_TX: Hex = `0x${'cd'.repeat(32)}`;
const API_KEY = 'mcp-swap-key';

type Provider = 'aurora' | 'across' | 'relay';
type Hit = { route: string; query: Record<string, string>; body?: Record<string, unknown>; apiKey: string | null };

const stub = {
  status: { state: 'PENDING_DEPOSIT' } as Record<string, unknown>,
  submit: { state: 'PENDING_DEPOSIT' } as Record<string, unknown> | number,
  hits: [] as Hit[],
};
const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const route = url.pathname.split('/').at(-1)!;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const query = Object.fromEntries(url.searchParams);
  stub.hits.push({ route, query, body, apiKey: new Headers(init?.headers).get('x-api-key') });
  const answer = route === 'submit' ? stub.submit : stub.status;
  if (typeof answer === 'number')
    return Response.json({ statusCode: answer, result: { error: 'x' } }, { status: answer });
  const key = { ...(body ?? query) };
  delete key.txHash;
  const echo = { ...key, ...(key.originChainId && { originChainId: Number(key.originChainId) }) };
  return Response.json({ statusCode: 200, result: { data: { ...echo, ...answer }, error: null } });
};
const deps: BackendDeps = { fetch, baseUrl: 'https://backend.test/proxy/v2', timeoutMs: 1_000, apiKey: API_KEY };

const event = parseAbi([
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
]);
const depositLog = (depositor: Address, depositId: bigint) => ({
  address: SPOKE_POOL,
  topics: encodeEventTopics({ abi: event, args: { destinationChainId: 42161n, depositId, depositor: pad(depositor) } }),
  data: encodeAbiParameters(
    parseAbi(['function f(bytes32,bytes32,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes)'])[0].inputs,
    [pad(USDC), pad(USDC), 1_000_000n, 999_000n, 1, 2, 0, pad(depositor), pad(zeroAddress), '0x']
  ),
});
const chain = { logs: [] as unknown[], reads: 0, fails: false };
const clients: ChainClients = {
  publicClient: () =>
    ({
      getTransactionReceipt: async () => {
        chain.reads++;
        if (chain.fails) throw new Error('not found');
        return { status: 'success', logs: chain.logs };
      },
    }) as never,
};

beforeEach(() => {
  stub.status = { state: 'PENDING_DEPOSIT' };
  stub.submit = { state: 'PENDING_DEPOSIT' };
  stub.hits = [];
  chain.logs = [depositLog('0x2222222222222222222222222222222222222222', 6n), depositLog(ACCOUNT, 7n)];
  chain.reads = 0;
  chain.fails = false;
});

async function swapRow(provider: Provider, state: SwapState, fields: Partial<SwapRow> = {}): Promise<SwapRow> {
  const connectionId = `con_${randomUUID()}`;
  await getDb()
    .insert(connections)
    .values({
      id: connectionId,
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
    });
  const id = `swp_${randomUUID()}`;
  const depositAddress = `0x${randomUUID().replaceAll('-', '')}00000000`;
  const quoteId = {
    aurora: `aurora:${depositAddress}`,
    relay: `relay:0x${randomBytes(32).toString('hex').toUpperCase()}`,
    across: `across:${randomUUID()}`,
  }[provider];
  const sent = state !== 'awaiting_owner' && state !== 'expired';
  const [row] = await getDb()
    .insert(swaps)
    .values({
      id,
      connectionId,
      idempotencyKey: id,
      requestHash: id,
      paymentKey: `swap:${id}:1`,
      leaseUntil: new Date(),
      originChainId: 8453,
      originToken: USDC.toLowerCase(),
      destinationChainId: 42161,
      destinationToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      amount: '1000000',
      depositor: ACCOUNT,
      recipient: ACCOUNT,
      state,
      quoteId,
      depositAddress: provider === 'aurora' ? depositAddress : null,
      quote: { provider },
      quoteFenced: '',
      call: [{ kind: 'deposit', chainId: 8453, to: SPOKE_POOL, data: '0x', value: '0' }],
      quotedAt: new Date(),
      walletUrl: 'https://keys.test/cli-bridge',
      approveBy: new Date(Date.now() + 60_000),
      ...(sent && { callsId: '0xcalls', txHash: TX }),
      ...fields,
    })
    .returning();
  return row;
}

const reread = async (row: SwapRow) => (await getDb().select().from(swaps).where(eq(swaps.id, row.id)))[0];

describe('given an Across or Relay swap the owner has not sent', () => {
  it.each([
    ['relay', 'awaiting_owner'],
    ['relay', 'expired'],
    ['across', 'awaiting_owner'],
    ['across', 'expired'],
  ] as const)(
    'when a %s %s row is tracked while the backend says SUCCESS, then no call is made and the row is unchanged',
    async (provider, state) => {
      stub.status = { state: 'SUCCESS', txHash: OTHER_TX };
      const row = await swapRow(provider, state);

      const read = await track(row, deps, clients);

      expect(read).toBeUndefined();
      expect(stub.hits).toEqual([]);
      expect(chain.reads).toBe(0);
      expect(await reread(row)).toEqual(row);
    }
  );

  it('when an Aurora awaiting_owner row is tracked, then the backend is read by deposit address as before', async () => {
    const row = await swapRow('aurora', 'awaiting_owner');

    await track(row, deps, clients);

    expect(stub.hits).toEqual([
      {
        route: 'status',
        query: { provider: 'aurora', depositAddress: row.depositAddress },
        body: undefined,
        apiKey: API_KEY,
      },
    ]);
  });
});

describe('given a sent Relay swap', () => {
  it('when status reads PENDING_DEPOSIT, then it reads by the lowercased request id and submits it again with the origin chain', async () => {
    const row = await swapRow('relay', 'deposit_sent');

    await track(row, deps, clients);

    const requestId = row.quoteId!.slice('relay:'.length).toLowerCase();
    expect(stub.hits.map(({ route, query, body }) => ({ route, query, body }))).toEqual([
      { route: 'status', query: { provider: 'relay', requestId }, body: undefined },
      { route: 'submit', query: {}, body: { provider: 'relay', requestId, txHash: TX, originChainId: 8453 } },
    ]);
    expect(stub.hits.every((h) => h.apiKey === API_KEY)).toBe(true);
  });

  it('when submit answers 200 PENDING_DEPOSIT, then the attempt is counted and the row stays deposit_sent', async () => {
    const row = await swapRow('relay', 'deposit_sent');

    await submit(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'deposit_sent', submitAttempts: 1 });
  });

  it.each(['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'])(
    'when submit answers %s with the row hash, then the row is submitted',
    async (state) => {
      stub.submit = { state, txHash: TX };
      const row = await swapRow('relay', 'deposit_sent');

      await submit(row, deps, clients);

      expect(await reread(row)).toMatchObject({ state: 'submitted', backendState: state, submitAttempts: 1 });
    }
  );

  it('when submit answers 502, then the row stays deposit_sent and the next status read submits again', async () => {
    stub.submit = 502;
    const row = await swapRow('relay', 'deposit_sent');
    await submit(row, deps, clients);
    stub.submit = { state: 'KNOWN_DEPOSIT_TX', txHash: TX };

    await track(await reread(row), deps, clients);

    expect(stub.hits.map((h) => h.route)).toEqual(['submit', 'status', 'submit']);
    expect(await reread(row)).toMatchObject({ state: 'submitted', submitAttempts: 2 });
  });

  it('when status reports SUCCESS for another deposit hash, then invalid_response and the row is unchanged', async () => {
    stub.status = { state: 'SUCCESS', txHash: OTHER_TX };
    const row = await swapRow('relay', 'submitted');

    const read = await track(row, deps, clients);

    expect(read).toEqual({ ok: false, code: 'invalid_response' });
    expect(await reread(row)).toEqual(row);
  });

  it.each([
    ['PROCESSING no_tx with the row hash', { state: 'PROCESSING', rawState: 'no_tx', txHash: TX }],
    ['PROCESSING failure with the row hash', { state: 'PROCESSING', rawState: 'failure', txHash: TX }],
    ['KNOWN_DEPOSIT_TX with no hash', { state: 'KNOWN_DEPOSIT_TX' }],
    ['SUCCESS with no hash', { state: 'SUCCESS' }],
  ])('when submit answers %s, then the attempt is counted and the row stays deposit_sent', async (_, answer) => {
    stub.submit = answer;
    const row = await swapRow('relay', 'deposit_sent');

    await submit(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'deposit_sent', backendState: null, submitAttempts: 1 });
  });

  it.each(['SUCCESS', 'REFUNDED'])(
    'when status reads %s with no hash, then the row stays submitted and keeps its hash',
    async (state) => {
      stub.status = { state };
      const row = await swapRow('relay', 'submitted');

      await track(row, deps, clients);

      expect(await reread(row)).toMatchObject({ state: 'submitted', txHash: TX });
    }
  );

  it.each(['SUCCESS', 'REFUNDED'])(
    'when status reads %s with a hash while the row has none, then the row goes no further than submitted and stores no hash',
    async (state) => {
      stub.status = { state, txHash: TX };
      const row = await swapRow('relay', 'deposit_sent', { txHash: null });

      await track(row, deps, clients);

      expect(await reread(row)).toMatchObject({ state: 'submitted', txHash: null });
      expect(stub.hits.map((h) => h.route)).toEqual(['status']);
    }
  );

  it('when submit answers SUCCESS for another deposit hash, then the row stays deposit_sent', async () => {
    stub.submit = { state: 'SUCCESS', txHash: OTHER_TX };
    const row = await swapRow('relay', 'deposit_sent');

    await submit(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'deposit_sent', submitAttempts: 1 });
  });

  it.each([
    ['SUCCESS', undefined, 'completed'],
    ['PROCESSING', 'no_tx', 'submitted'],
    ['PROCESSING', 'failure', 'submitted'],
    ['REFUNDED', undefined, 'refunded'],
    ['FAILED', undefined, 'failed'],
  ])('when status reads %s (%s) with the row hash, then the row is %s', async (state, rawState, swapState) => {
    stub.status = { state, txHash: TX, ...(rawState && { rawState }) };
    const row = await swapRow('relay', 'submitted');

    await track(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: swapState, backendRawState: rawState ?? null });
  });

  it('when a reverted deposit reads PENDING_DEPOSIT, then it is not submitted', async () => {
    const row = await swapRow('relay', 'deposit_sent', { code: DEPOSIT_REVERTED });

    await track(row, deps, clients);

    expect(stub.hits.map((h) => h.route)).toEqual(['status']);
  });
});

describe('given a sent Across swap', () => {
  it("when tracked, then the depositId is the account's log in the receipt and status reads it", async () => {
    const row = await swapRow('across', 'deposit_sent');

    await track(row, deps, clients);

    expect(stub.hits.map(({ route, query }) => ({ route, query }))).toEqual([
      { route: 'status', query: { provider: 'across', originChainId: '8453', depositId: '7' } },
    ]);
  });

  it('when a PENDING_DEPOSIT row is polled twice, then each poll makes one status call and no submit', async () => {
    const row = await swapRow('across', 'deposit_sent');

    await track(row, deps, clients);
    await track(await reread(row), deps, clients);

    expect(stub.hits.map((h) => h.route)).toEqual(['status', 'status']);
    expect(await reread(row)).toMatchObject({ state: 'deposit_sent', submitAttempts: 0 });
  });

  it('when submitted after the hash is recorded, then the body names the depositId and the hash', async () => {
    const row = await swapRow('across', 'deposit_sent');

    await submit(row, deps, clients);

    expect(stub.hits.map(({ route, body }) => ({ route, body }))).toEqual([
      { route: 'submit', body: { provider: 'across', originChainId: 8453, depositId: '7', txHash: TX } },
    ]);
  });

  it('when status reads PROCESSING expired, then the row is submitted and not final', async () => {
    stub.status = { state: 'PROCESSING', rawState: 'expired', txHash: TX };
    const row = await swapRow('across', 'submitted');

    await track(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'submitted', backendRawState: 'expired' });
  });

  it('when status reads SUCCESS actions_failed, then the row is completed and keeps the rawState', async () => {
    stub.status = { state: 'SUCCESS', rawState: 'actions_failed', txHash: TX };
    const row = await swapRow('across', 'submitted');

    await track(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'completed', backendRawState: 'actions_failed' });
  });

  it('when the row has no hash yet, then hash_unknown with no receipt read and no backend call', async () => {
    const row = await swapRow('across', 'deposit_sent', { txHash: null });

    expect(await track(row, deps, clients)).toEqual({ ok: false, code: 'hash_unknown' });
    expect(chain.reads).toBe(0);
    expect(stub.hits).toEqual([]);
  });

  it('when the receipt holds two deposits of the account, then the row keeps deposit_ambiguous and later polls read nothing', async () => {
    chain.logs = [depositLog(ACCOUNT, 7n), depositLog(ACCOUNT, 8n)];
    const row = await swapRow('across', 'deposit_sent');

    const first = await track(row, deps, clients);
    const again = await track(await reread(row), deps, clients);

    expect([first, again]).toEqual([
      { ok: false, code: 'deposit_ambiguous' },
      { ok: false, code: 'deposit_ambiguous' },
    ]);
    expect(chain.reads).toBe(1);
    expect(stub.hits).toEqual([]);
    expect(await reread(row)).toMatchObject({ state: 'deposit_sent', code: 'deposit_ambiguous', txHash: TX });
  });

  it.each([
    ['no deposit of the account', 'deposit_not_found', () => (chain.logs = [])],
    ['nothing readable', 'receipt_missing', () => (chain.fails = true)],
  ])('when the receipt holds %s, then %s, no backend call and the row is unchanged', async (_, code, setup) => {
    setup();
    const row = await swapRow('across', 'deposit_sent');

    expect(await track(row, deps, clients)).toEqual({ ok: false, code });
    expect(stub.hits).toEqual([]);
    expect(await reread(row)).toEqual(row);
  });

  it('when submitted after the hash is recorded and submit answers PENDING_DEPOSIT not_found, then the row stays deposit_sent', async () => {
    stub.submit = { state: 'PENDING_DEPOSIT', rawState: 'not_found' };
    const row = await swapRow('across', 'deposit_sent');

    await submit(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'deposit_sent', submitAttempts: 1 });
  });
});

describe('given a sent Aurora swap', () => {
  it('when submit answers 200 PENDING_DEPOSIT, then it is accepted as today', async () => {
    const row = await swapRow('aurora', 'deposit_sent');

    await submit(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'submitted', submitAttempts: 1 });
  });

  it('when status reports another deposit hash, then it is kept as today', async () => {
    stub.status = { state: 'SUCCESS', txHash: OTHER_TX };
    const row = await swapRow('aurora', 'submitted');

    await track(row, deps, clients);

    expect(await reread(row)).toMatchObject({ state: 'completed' });
  });
});
