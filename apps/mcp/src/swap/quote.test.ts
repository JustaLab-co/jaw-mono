import { eq, sql } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, getAddress, keccak256, toHex, type Address } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { connect, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { payments, swaps } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { quote, swapRequest, type QuoteDeps, type SwapInput } from './quote';
import { claimSwap, type SwapRow } from './store';

const USDC_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const KEY = 'swap-test-key';

const lookups = vi.hoisted(() => ({ meet: 0, waiting: [] as (() => void)[] }));

vi.mock('./store', async (original) => {
  const real = await original<typeof import('./store')>();
  return {
    ...real,
    isDepositAddressTaken: async (address: string) => {
      const taken = await real.isDepositAddressTaken(address);
      if (lookups.meet === 0) return taken;
      await new Promise<void>((resume) => {
        lookups.waiting.push(resume);
        if (lookups.waiting.length === lookups.meet) lookups.waiting.forEach((r) => r());
      });
      return taken;
    },
  };
});

setTestEnv();

type Hit = { url: URL; apiKey: string | null };

const backend = {
  mode: '' as '' | '400' | '422' | '503' | 'down' | 'invalid' | '203' | 'trailing-bytes' | '401' | '402' | '403',
  deposit: undefined as Address | undefined,
  onAsked: undefined as (() => Promise<void>) | undefined,
  answered: 0,
  hits: [] as Hit[],
};

const transfer = (to: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });

const envelope = (status: number, data: unknown, error: unknown) =>
  new Response(JSON.stringify({ statusCode: status, result: { data, error } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function auroraQuote(query: URLSearchParams, deposit: Address) {
  const amount = BigInt(query.get('amount')!);
  const out = amount - amount / 200n;
  const quote = {
    quoteId: `aurora:${deposit}`,
    provider: 'aurora',
    inputAmount: String(amount),
    expectedOutputAmount: String(out),
    minOutputAmount: String(out - out / 200n),
    expectedFillTimeSec: 20,
    fees: { totalUsd: '0.008045' },
    transactions: [
      {
        chainId: Number(query.get('originChainId')),
        to: getAddress(query.get('originToken')!),
        data: transfer(deposit, amount),
        value: '0',
        description: 'deposit',
      },
    ],
  };
  if (backend.mode === 'trailing-bytes') quote.transactions[0].data += '00';
  return quote;
}

// The backend as the proxy runs it with X402_ALLOWED_API_KEYS=swap-test-key: that key quotes for free,
// anything else gets the x402 challenge.
const quoteBackend: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const apiKey = new Headers(init?.headers).get('x-api-key');
  backend.hits.push({ url, apiKey });
  if (backend.mode === 'down') throw new TypeError('socket hang up');
  if (backend.mode === '400') return envelope(400, null, ['originChainId must be a positive number']);
  if (backend.mode === '422') return envelope(422, null, 'NoProviderAvailable: aurora=amount is too low for bridge');
  if (backend.mode === '503') return envelope(503, null, 'upstream unavailable');
  for (const status of [401, 402, 403]) {
    if (backend.mode === String(status)) return new Response('{}', { status });
  }
  if (apiKey !== KEY) return new Response('{}', { status: 402, headers: { 'payment-required': 'e30=' } });
  await backend.onAsked?.();
  backend.answered += 1;
  const deposit =
    backend.deposit ?? getAddress(`0x${keccak256(toHex(`${backend.answered}:${Math.random()}`)).slice(-40)}`);
  if (backend.mode === 'invalid') return envelope(200, null, null);
  if (backend.mode === '203')
    return new Response(JSON.stringify({ result: { data: auroraQuote(url.searchParams, deposit) } }), { status: 203 });
  return envelope(200, auroraQuote(url.searchParams, deposit), null);
};

const deps = (apiKey = KEY): QuoteDeps => ({ fetch: quoteBackend, apiKey, timeoutMs: 1000 });

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  Object.assign(backend, { mode: '', deposit: undefined, onAsked: undefined, answered: 0 });
  backend.hits.length = 0;
  lookups.meet = 0;
  lookups.waiting.length = 0;
});
afterEach(() => vi.restoreAllMocks());

async function connected(): Promise<Tenant> {
  const c = await connect(undefined, { scope: 'wallet:read' });
  return (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
}

const input: SwapInput = {
  originChainId: 84532,
  originToken: USDC_SEPOLIA,
  destinationChainId: 42161,
  destinationToken: ARB_USDC,
  amount: '1000000',
};

async function claimed(t: Tenant, key = 'agent-key', swap = input) {
  const claim = await claimSwap(t.connectionId, key, swapRequest(t, swap));
  if (claim.kind !== 'run') throw new Error(`claimed ${claim.kind}`);
  return claim;
}

async function quoted(t: Tenant, key = 'agent-key', d = deps()) {
  const step = await quote(t, await claimed(t, key), d);
  if (step.kind !== 'done') throw new Error('the lease was lost');
  return step;
}

const swapOf = async (id: string): Promise<SwapRow> => (await getDb().select().from(swaps).where(eq(swaps.id, id)))[0];
const paymentsOf = (connectionId: string) =>
  getDb().select().from(payments).where(eq(payments.connectionId, connectionId));

describe('the quote request', () => {
  it('given no recipient, when the request is built, then the account is both depositor and recipient, hex in lowercase', async () => {
    const t = await connected();
    expect(swapRequest(t, input)).toEqual({
      originChainId: 84532,
      originToken: USDC_SEPOLIA.toLowerCase(),
      destinationChainId: 42161,
      destinationToken: ARB_USDC,
      amount: '1000000',
      depositor: t.account.toLowerCase(),
      recipient: t.account.toLowerCase(),
    });
  });

  it('given a recipient, when the request is built, then it is kept and the depositor is still the account', async () => {
    const t = await connected();
    const recipient = 'So11111111111111111111111111111111111111112';
    expect(swapRequest(t, { ...input, recipient })).toMatchObject({ depositor: t.account.toLowerCase(), recipient });
  });

  it('given a valid pair, when the quote is asked, then the backend from config gets the stored input once, with the swap api key in a header and not in the url', async () => {
    const t = await connected();
    await quoted(t);

    expect(backend.hits).toHaveLength(1);
    const [hit] = backend.hits;
    expect(`${hit.url.origin}${hit.url.pathname}`).toBe(`${config().swapUrl}/swap/quote`);
    expect(Object.fromEntries(hit.url.searchParams)).toEqual({
      originChainId: '84532',
      destinationChainId: '42161',
      originToken: USDC_SEPOLIA.toLowerCase(),
      destinationToken: ARB_USDC,
      amount: '1000000',
      depositor: t.account.toLowerCase(),
      recipient: t.account.toLowerCase(),
      tradeType: 'EXACT_INPUT',
    });
    expect(hit.apiKey).toBe(KEY);
    expect(hit.url.href).not.toContain(KEY);
  });
});

describe('a quote', () => {
  it('given a connection with wallet:read only and no budget, when the quote is asked, then the row holds the checked quote, its call and when it was asked, and nothing is paid', async () => {
    const t = await connected();
    expect(t.scopes).toEqual(['wallet:read']);
    const claim = await claimed(t);
    const before = Date.now();

    const step = await quote(t, claim, deps());

    const row = await swapOf(claim.row.id);
    const deposit = row.depositAddress as Address;
    expect(step).toMatchObject({ kind: 'done' });
    expect(row).toMatchObject({
      state: 'quoting',
      code: null,
      quoteId: `aurora:${deposit}`,
      call: { chainId: 84532, to: getAddress(USDC_SEPOLIA), data: transfer(deposit, 1_000_000n), value: '0' },
      quote: { inputAmount: '1000000', expectedOutputAmount: '995000', minOutputAmount: '990025' },
      paymentId: null,
      leaseToken: claim.token,
    });
    expect(row.quotedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.quotedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.quoteFenced).toMatch(/^\[untrusted text from [^\]]+\][\s\S]*aurora:0x/);
    expect(await paymentsOf(t.connectionId)).toHaveLength(0);
  });

  it('given a row already holding its checked quote, when the quote step runs again, then nothing is asked and the row is unchanged', async () => {
    const t = await connected();
    const claim = await claimed(t);
    const first = await quote(t, claim, deps());
    if (first.kind !== 'done') throw new Error('the lease was lost');

    const again = await quote(t, { row: first.row, token: claim.token }, deps());

    expect(again).toEqual({ kind: 'done', row: first.row });
    expect(backend.hits).toHaveLength(1);
    expect(await swapOf(claim.row.id)).toEqual(first.row);
  });

  it('given a deposit address another swap row already holds, when the quote is asked, then the swaps store refuses it as deposit_address_reused', async () => {
    const held = await quoted(await connected());
    backend.deposit = held.row.depositAddress as Address;

    const { row } = await quoted(await connected());

    expect(row).toMatchObject({ state: 'quote_rejected', code: 'deposit_address_reused', quoteId: null });
  });

  it('given another recipient and a quote whose deposit address is the account, when the quote is asked, then quote_rejected with deposit_address', async () => {
    const t = await connected();
    backend.deposit = t.account;
    const claim = await claimed(t, 'agent-key', { ...input, recipient: '0x4444444444444444444444444444444444444444' });

    const step = await quote(t, claim, deps());

    expect(step).toMatchObject({ kind: 'done', row: { state: 'quote_rejected', code: 'deposit_address' } });
  });

  it('given a deposit whose calldata has trailing bytes, when the quote is asked, then quote_rejected with tx_data and no call kept', async () => {
    backend.mode = 'trailing-bytes';

    const { row } = await quoted(await connected());

    expect(row).toMatchObject({ state: 'quote_rejected', code: 'tx_data', quoteId: null, call: null });
    expect(row.quoteFenced).toMatch(/^\[untrusted text from /);
  });
});

describe('quote_failed codes', () => {
  it.each([
    ['refuses the pair (422)', '422', /NoProviderAvailable/],
    ['refuses the input (400)', '400', /originChainId must be a positive number/],
  ] as const)(
    'B6: given the backend %s, when the quote is asked, then quote_unavailable with the reason fenced, and the same key returns it without asking again',
    async (_, mode, reason) => {
      const t = await connected();
      backend.mode = mode;

      const { row } = await quoted(t);

      expect(row).toMatchObject({ state: 'quote_failed', code: 'quote_unavailable', quoteId: null });
      expect(row.quoteFenced).toMatch(/^\[untrusted text from [^\]]+\]/);
      expect(row.quoteFenced).toMatch(reason);
      expect(await claimSwap(t.connectionId, 'agent-key', swapRequest(t, input))).toMatchObject({ kind: 'stored' });
      expect(backend.hits).toHaveLength(1);
    }
  );

  it.each([
    ['answers 200 with no quote', 'invalid'],
    ['answers a quote with a 203 rather than a 200', '203'],
  ] as const)(
    'B7: given the backend %s, when the quote is asked, then quote_invalid, and the same key returns it without asking again',
    async (_, mode) => {
      const t = await connected();
      backend.mode = mode;

      const { row } = await quoted(t);

      expect(row).toMatchObject({ state: 'quote_failed', code: 'quote_invalid', quoteId: null });
      expect(await claimSwap(t.connectionId, 'agent-key', swapRequest(t, input))).toMatchObject({
        kind: 'stored',
        row: { id: row.id, state: 'quote_failed', code: 'quote_invalid' },
      });
      expect(backend.hits).toHaveLength(1);
    }
  );

  it('given a swap url over plain http to a remote host, when the quote is asked, then quote_failed with insecure_url and nothing asked', async () => {
    const t = await connected();
    const was = config().swapUrl;
    config().swapUrl = 'http://quote.test/proxy/v2';
    try {
      const { row } = await quoted(t);

      expect(row).toMatchObject({ state: 'quote_failed', code: 'insecure_url', quoteId: null });
      expect(backend.hits).toHaveLength(0);
    } finally {
      config().swapUrl = was;
    }
  });

  it('given an origin token that is not an address, when the quote is asked, then quote_failed with invalid_request and nothing asked', async () => {
    const t = await connected();
    const claim = await claimed(t, 'agent-key', { ...input, originToken: '0xnot-a-token' as Address });

    const step = await quote(t, claim, deps());

    expect(step).toMatchObject({ kind: 'done', row: { state: 'quote_failed', code: 'invalid_request' } });
    expect(backend.hits).toHaveLength(0);
  });
});

describe('answers that leave the swap quoting', () => {
  it.each([
    ['answers 503', '503'],
    ['cannot be reached', 'down'],
  ] as const)(
    'given the backend %s, when the quote is asked, then quoting with backend_unavailable and the lease released; the same key asks again and holds the quote',
    async (_, mode) => {
      const t = await connected();
      backend.mode = mode;

      const down = await quoted(t);

      expect(down.row).toMatchObject({
        state: 'quoting',
        code: 'backend_unavailable',
        quoteId: null,
        leaseToken: null,
      });

      backend.mode = '';
      const { row } = await quoted(t);

      expect(row).toMatchObject({ id: down.row.id, state: 'quoting', code: null });
      expect(row.quoteId).toMatch(/^aurora:0x/);
      expect(backend.hits).toHaveLength(2);
    }
  );

  it.each(['401', '402', '403'] as const)(
    'given the backend answers %s to the api key, when the quote is asked, then quoting with backend_unavailable and the refusal logged as an error',
    async (mode) => {
      const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      backend.mode = mode;

      const { row } = await quoted(await connected());

      expect(row).toMatchObject({ state: 'quoting', code: 'backend_unavailable', quoteId: null, leaseToken: null });
      const lines = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual(
        expect.objectContaining({ level: 'error', msg: 'swap backend refused the swap api key', status: Number(mode) })
      );
    }
  );

  it('given a key the backend does not list, when the quote is asked, then its x402 challenge leaves the swap quoting and nothing is paid', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const t = await connected();

    const { row } = await quoted(t, 'agent-key', deps('not-listed'));

    expect(row).toMatchObject({ state: 'quoting', code: 'backend_unavailable', quoteId: null });
    expect(await paymentsOf(t.connectionId)).toHaveLength(0);
  });

  it('B17: given a crash after the quote came back and before the swap kept it, when the lease lapses and the key returns, then the quote is asked again and held', async () => {
    const t = await connected();
    await getDb().execute(
      sql.raw(`create function fail_quote_write() returns trigger language plpgsql as $$ begin
        if new.quote_id is not null or new.state <> 'quoting' then raise exception 'crash'; end if;
        return new; end $$`)
    );
    await getDb().execute(
      sql.raw('create trigger fail_quote_write before update on swaps for each row execute function fail_quote_write()')
    );
    const first = await claimed(t);
    await expect(quote(t, first, deps())).rejects.toThrow();
    await getDb().execute(sql.raw('drop trigger fail_quote_write on swaps'));
    await getDb().execute(sql.raw('drop function fail_quote_write()'));
    await getDb()
      .update(swaps)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(swaps.id, first.row.id));

    const { row } = await quoted(t);

    expect(row).toMatchObject({ id: first.row.id, state: 'quoting' });
    expect(row.quoteId).toMatch(/^aurora:0x/);
    expect(backend.hits).toHaveLength(2);
  });
});

describe('leases', () => {
  it('given the lease lapses and another call takes the swap while the quote is asked, when the answer comes, then lease_lost; the new holder asks for its own quote and keeps it', async () => {
    const t = await connected();
    const first = await claimed(t);
    let second: Awaited<ReturnType<typeof claimed>> | undefined;
    backend.onAsked = async () => {
      backend.onAsked = undefined;
      await getDb()
        .update(swaps)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(eq(swaps.id, first.row.id));
      second = await claimed(t);
    };

    const lost = await quote(t, first, deps());

    expect(lost).toEqual({ kind: 'lease_lost' });
    expect(await swapOf(first.row.id)).toMatchObject({ quoteId: null, code: null, leaseToken: second!.token });

    const step = await quote(t, second!, deps());

    expect(step).toMatchObject({ kind: 'done', row: { quoteId: expect.stringMatching(/^aurora:0x/) } });
  });
});

describe('deposit addresses raced', () => {
  it('given two swaps whose quotes name the same deposit address, when both are asked at once, then one holds it and the other is quote_rejected with deposit_address_reused', async () => {
    const [one, two] = [await connected(), await connected()];
    backend.deposit = '0x5555555555555555555555555555555555555555';
    lookups.meet = 2;

    const steps = await Promise.all([quoted(one), quoted(two)]);

    expect(steps.map((s) => s.row)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'quoting', depositAddress: backend.deposit }),
        expect.objectContaining({ state: 'quote_rejected', code: 'deposit_address_reused', quoteId: null }),
      ])
    );
  });
});
