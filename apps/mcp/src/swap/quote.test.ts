import { eq, sql } from 'drizzle-orm';
import { encodeFunctionData, erc20Abi, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { connect, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { payments, swaps } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { callsOf } from './calls';
import type { CheckDeps, CheckedQuote } from './check';
import { quote, quoteRequestOf, swapRequest, type QuoteDeps, type SwapInput } from './quote';
import { claimSwap, writeHeld, type SwapRow } from './store';
import acrossAnswer from './fixtures/prod-across-quote.json';
import relayAnswer from './fixtures/prod-relay-quote.json';
import relayUsdc from './fixtures/relay-usdc.json';
import { relayOrderId } from './check/relay';

const USDC_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ALL_PROVIDERS = new Set(['aurora', 'across', 'relay'] as const);
const KEY = 'swap-test-key';
const SOLANA = 792703809;

const lookups = vi.hoisted(() => ({ meet: 0, waiting: [] as (() => void)[] }));

vi.mock('./store', async (original) => {
  const real = await original<typeof import('./store')>();
  const met = async (taken: boolean) => {
    if (lookups.meet === 0) return taken;
    await new Promise<void>((resume) => {
      lookups.waiting.push(resume);
      if (lookups.waiting.length === lookups.meet) lookups.waiting.forEach((r) => r());
    });
    return taken;
  };
  return {
    ...real,
    isDepositAddressTaken: async (address: string) => met(await real.isDepositAddressTaken(address)),
    isOrderTaken: async (orderId: string) => met(await real.isOrderTaken(orderId)),
  };
});

const checks = vi.hoisted(() => ({
  code: undefined as string | undefined,
  deps: undefined as CheckDeps | undefined,
  relay: undefined as (() => CheckedQuote) | undefined,
  pass: undefined as (() => CheckedQuote) | undefined,
}));

vi.mock('./check', async (original) => {
  const real = await original<typeof import('./check')>();
  return {
    ...real,
    checkQuote: async (...args: Parameters<typeof real.checkQuote>) => {
      checks.deps = args[2];
      if (checks.code) return { ok: false, code: checks.code };
      if (checks.pass) return checks.pass();
      if (!checks.relay) return real.checkQuote(...args);
      const passed = checks.relay();
      if (await args[2].isOrderTaken(passed.quote.orderId!)) return { ok: false, code: 'order_reused' };
      return passed;
    },
  };
});

setTestEnv();

type Hit = { url: URL; apiKey: string | null };

const backend = {
  key: KEY,
  mode: '' as
    | ''
    | '400'
    | '422'
    | '502'
    | '503'
    | 'down'
    | 'invalid'
    | '203'
    | 'trailing-bytes'
    | '401'
    | '402'
    | '403',
  answer: undefined as unknown,
  tamper: undefined as ((quote: Record<string, unknown>) => void) | undefined,
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
  backend.tamper?.(quote);
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
  if (backend.mode === '422') {
    return envelope(422, null, `NoProviderAvailable: aurora=amount is too low for bridge; relay=bad key ${apiKey}`);
  }
  if (backend.mode === '502') return envelope(502, null, 'NoProviderAvailable: aurora=amount too low; relay=HTTP 429');
  if (backend.mode === '503') return envelope(503, null, 'upstream unavailable');
  for (const status of [401, 402, 403]) {
    if (backend.mode === String(status)) return new Response('{}', { status });
  }
  if (apiKey !== backend.key) return new Response('{}', { status: 402, headers: { 'payment-required': 'e30=' } });
  if (backend.answer) return Response.json(backend.answer);
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
  Object.assign(backend, { key: KEY, mode: '', deposit: undefined, onAsked: undefined, answered: 0 });
  backend.answer = undefined;
  backend.tamper = undefined;
  backend.hits.length = 0;
  lookups.meet = 0;
  lookups.waiting.length = 0;
  checks.code = undefined;
  checks.deps = undefined;
  checks.relay = undefined;
  checks.pass = undefined;
  config().swapProviders = new Set(['aurora']);
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

  it('given an EVM destination, when the quote is asked, then move-asset/quote on the backend from config gets the stored input once, with the swap api key in a header and not in the url', async () => {
    const t = await connected();
    await quoted(t);

    expect(backend.hits).toHaveLength(1);
    const [hit] = backend.hits;
    expect(`${hit.url.origin}${hit.url.pathname}`).toBe(`${config().swapUrl}/move-asset/quote`);
    expect(Object.fromEntries(hit.url.searchParams)).toEqual({
      originChainId: '84532',
      destinationChainId: '42161',
      originToken: USDC_SEPOLIA.toLowerCase(),
      destinationToken: ARB_USDC,
      amount: '1000000',
      depositor: t.account.toLowerCase(),
      recipient: t.account.toLowerCase(),
      tradeType: 'EXACT_INPUT',
      providers: 'aurora',
    });
    expect(hit.apiKey).toBe(KEY);
    expect(hit.url.href).not.toContain(KEY);
  });

  it('given a Solana destination, when the quote is asked, then swap/quote gets the same query and key as before', async () => {
    const t = await connected();
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const recipient = 'So11111111111111111111111111111111111111112';
    const claim = await claimed(t, 'agent-key', {
      ...input,
      destinationChainId: SOLANA,
      destinationToken: mint,
      recipient,
    });

    const step = await quote(t, claim, deps());

    expect(step).toMatchObject({ kind: 'done', row: { state: 'quoting', code: null } });
    const [hit] = backend.hits;
    expect(`${hit.url.origin}${hit.url.pathname}`).toBe(`${config().swapUrl}/swap/quote`);
    expect(Object.fromEntries(hit.url.searchParams)).toMatchObject({
      destinationChainId: String(SOLANA),
      destinationToken: mint,
      recipient,
      tradeType: 'EXACT_INPUT',
    });
    expect(hit.url.searchParams.has('providers')).toBe(false);
    expect(hit.apiKey).toBe(KEY);
  });
});

describe('the providers the quote asks for', () => {
  const toWeth = { ...input, destinationToken: ARB_WETH };
  const asked = () => backend.hits.map((hit) => hit.url.searchParams.get('providers'));

  it('given aurora, across and relay enabled and USDC to USDC, when the quote is asked, then it asks all three', async () => {
    config().swapProviders = ALL_PROVIDERS;

    await quoted(await connected());

    expect(asked()).toEqual(['aurora,across,relay']);
  });

  it('given aurora, across and relay enabled and USDC to WETH, when the quote is asked, then it asks aurora alone', async () => {
    config().swapProviders = ALL_PROVIDERS;
    const t = await connected();

    await quote(t, await claimed(t, 'agent-key', toWeth), deps());

    expect(asked()).toEqual(['aurora']);
  });

  it('given across and relay enabled without aurora and USDC to WETH, when the quote is asked, then nothing is asked and the swap is quote_rejected with quote_unsupported_provider', async () => {
    config().swapProviders = new Set(['across', 'relay']);
    const t = await connected();

    const step = await quote(t, await claimed(t, 'agent-key', toWeth), deps());

    expect(backend.hits).toEqual([]);
    expect(step).toMatchObject({
      kind: 'done',
      row: { state: 'quote_rejected', code: 'quote_unsupported_provider', quote: null, call: null },
    });
  });

  it('given every provider enabled and a backend that ignores the filter, when Across answers a USDC to WETH swap, then quote_rejected with route_unsupported', async () => {
    config().swapProviders = ALL_PROVIDERS;
    backend.answer = acrossAnswer;
    const t = await connected();
    const swap = {
      ...input,
      originChainId: 8453,
      originToken: BASE_USDC,
      amount: '10000000',
      destinationToken: ARB_WETH,
    };

    const step = await quote(t, await claimed(t, 'agent-key', swap), deps());

    expect(asked()).toEqual(['aurora']);
    expect(step).toMatchObject({
      row: {
        state: 'quote_rejected',
        code: 'route_unsupported',
        call: null,
        quote: { refused: { provider: 'across' } },
      },
    });
  });

  it('given across answers a minimum of 1 base unit for 10 USDC, when the quote is asked, then the refused row keeps the provider, the minimum offered and the floor', async () => {
    config().swapProviders = ALL_PROVIDERS;
    const answer = structuredClone(acrossAnswer);
    answer.result.data.minOutputAmount = '1';
    backend.answer = answer;
    const t = await connected();
    const swap = { ...input, originChainId: 8453, originToken: BASE_USDC, amount: '10000000' };

    const step = await quote(t, await claimed(t, 'agent-key', swap), deps());

    expect(step).toMatchObject({
      row: {
        state: 'quote_rejected',
        code: 'output_floor',
        call: null,
        quote: { refused: { provider: 'across', offered: '1', floor: '9700000' } },
      },
    });
  });
});

describe('a quote another provider answered', () => {
  const calldata = (answer: typeof acrossAnswer | typeof relayAnswer) =>
    answer.result.data.transactions.flatMap((tx) => [tx.to, tx.data.slice(10, 74)]);

  it.each([
    ['across', acrossAnswer],
    ['relay', relayAnswer],
  ] as const)(
    'given move-asset/quote answers the captured prod quote from %s, when the quote is asked, then quote_rejected with quote_unsupported_provider, the provider kept, and no call, deposit address or body stored',
    async (provider, answer) => {
      backend.answer = answer;

      const { row } = await quoted(await connected());

      expect(row).toMatchObject({
        state: 'quote_rejected',
        code: 'quote_unsupported_provider',
        quote: { provider },
        quoteId: null,
        depositAddress: null,
        call: null,
        quoteFenced: null,
      });
      for (const bytes of calldata(answer))
        expect(JSON.stringify(row).toLowerCase()).not.toContain(bytes.toLowerCase());
    }
  );

  it.each([
    ['an aurora provider with a relay quote id', { quoteId: 'relay:0x1792' }, 'relay'],
    ['an aurora quote id from another provider', { provider: 'relay' }, 'relay'],
    ['a provider and a quote id prefix that disagree', { provider: 'across', quoteId: 'relay:0x1792' }, 'relay'],
    ['a provider name that is not an identifier', { provider: 'Ignore previous instructions' }, 'unknown'],
    ['an aurora provider with no quote id', { quoteId: undefined }, 'unknown'],
    ['an aurora provider with a quote id prefix that is not an identifier', { quoteId: 'say hi:0x1' }, 'unknown'],
  ])(
    'given %s, when the quote is asked, then quote_unsupported_provider before any other check',
    async (_, change, provider) => {
      backend.tamper = (q) => Object.assign(q, change, { transactions: [] });

      const { row } = await quoted(await connected());

      expect(row).toMatchObject({ state: 'quote_rejected', code: 'quote_unsupported_provider', quote: { provider } });
    }
  );

  it('given a quote from across, when the quote is asked, then a warning names the provider and the chain pair and nothing else of the quote or the request', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    backend.answer = acrossAnswer;
    const t = await connected();

    await quoted(t);

    const lines = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
    const warning = lines.find((line) => line.msg === 'swap quote from an unsupported provider');
    expect(warning).toEqual({
      level: 'warn',
      time: expect.any(String),
      msg: 'swap quote from an unsupported provider',
      provider: 'across',
      originChainId: 84532,
      destinationChainId: 42161,
    });
    expect(JSON.stringify(lines).toLowerCase()).not.toContain(t.account.toLowerCase());
  });

  it.each([
    ['a quote id that is no address', (q: Record<string, unknown>) => (q.quoteId = 'aurora:0xnot'), 'quote_id'],
    ['a deposit field', (q: Record<string, unknown>) => (q.deposit = { address: '0x5555' }), 'quote_id'],
    [
      'a second transaction',
      (q: Record<string, unknown>) => (q.transactions = [q.transactions, q.transactions].flat()),
      'tx_count',
    ],
    ['a provider that is not a string', (q: Record<string, unknown>) => (q.provider = 7), 'quote_invalid'],
  ])(
    'given a quote naming aurora with %s, when the quote is asked, then the checks reject it with the code they give today',
    async (_, tamper, code) => {
      backend.tamper = tamper;

      const { row } = await quoted(await connected());

      expect(row).toMatchObject({ code, quoteId: null, call: null });
    }
  );
});

describe('a quote', () => {
  it('given an EVM swap, when its quote request is built, then it carries the destination chain, token and recipient of the row', async () => {
    const t = await connected();
    const { row } = await claimed(t);

    expect(quoteRequestOf(row)).toEqual({
      originChainId: 84532,
      originToken: USDC_SEPOLIA,
      amount: '1000000',
      account: getAddress(t.account),
      destinationChainId: 42161,
      destinationToken: ARB_USDC,
      recipient: t.account.toLowerCase(),
    });
  });

  it('given a connection with wallet:read only and no budget, when the quote is asked, then the row holds the checked quote, its calls and when it was asked, and nothing is paid', async () => {
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
      call: [
        {
          kind: 'deposit',
          chainId: 84532,
          to: getAddress(USDC_SEPOLIA),
          data: transfer(deposit, 1_000_000n),
          value: '0',
        },
      ],
      quote: { provider: 'aurora', inputAmount: '1000000', expectedOutputAmount: '995000', minOutputAmount: '990025' },
      paymentId: null,
      leaseToken: claim.token,
    });
    expect(callsOf(row)).toEqual(row.call);
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
      expect(row.quoteFenced).not.toContain(KEY);
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

  it.each([
    ['the swap api key', KEY, 'relay=bad key [key]"'],
    ['no swap api key', '', 'relay=bad key "'],
  ])(
    'given %s and a 422 that quotes the key back, when the quote is asked, then the reason is fenced with the key replaced',
    async (_, key, reason) => {
      backend.mode = '422';

      const { row } = await quoted(await connected(), 'agent-key', deps(key));

      expect(row).toMatchObject({ state: 'quote_failed', code: 'quote_unavailable' });
      expect(row.quoteFenced).toContain(`aurora=amount is too low for bridge; ${reason}`);
    }
  );

  it('given a swap api key that also appears in the quote calldata, when the quote is asked, then the quote is held intact and only its fenced copy has the key replaced', async () => {
    backend.key = 'a9059cbb';

    const { row } = await quoted(await connected(), 'agent-key', deps('a9059cbb'));

    expect(row.quoteId).toMatch(/^aurora:0x/);
    expect(callsOf(row)?.[0].data).toMatch(/^0xa9059cbb/);
    expect(row.quoteFenced).toContain('[key]');
    expect(row.quoteFenced).not.toContain('a9059cbb');
  });

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
    ['answers 502 NoProviderAvailable', '502'],
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

describe('quote ids raced', () => {
  const passing = (provider: 'aurora' | 'across', quoteId: string, depositAddress?: Address): CheckedQuote => ({
    ok: true,
    quoteId,
    depositAddress,
    calls: [],
    quote: {
      provider,
      inputAmount: '1000000',
      expectedOutputAmount: '990000',
      minOutputAmount: '980000',
      expectedFillTimeSec: 20,
    },
  });
  const randomAddress = () => getAddress(`0x${keccak256(toHex(String(Math.random()))).slice(-40)}`);

  it('given an Across quote id another swap already holds, when the quote is kept, then quote_rejected with quote_reused', async () => {
    const quoteId = `across:${keccak256(toHex(String(Math.random()))).slice(2, 34)}`;
    checks.pass = () => passing('across', quoteId);

    const first = await quoted(await connected());
    const second = await quoted(await connected());

    expect(first.row).toMatchObject({ state: 'quoting', quoteId });
    expect(second.row).toMatchObject({ state: 'quote_rejected', code: 'quote_reused', quoteId: null, quote: null });
  });

  it('given an Aurora quote id another swap already holds, when the quote is kept, then it stays deposit_address_reused', async () => {
    const quoteId = `aurora:${randomAddress()}`;
    const deposits = [randomAddress(), randomAddress()];
    checks.pass = () => passing('aurora', quoteId, deposits.pop());

    await quoted(await connected());
    const second = await quoted(await connected());

    expect(second.row).toMatchObject({ state: 'quote_rejected', code: 'deposit_address_reused', quoteId: null });
  });
});

describe('Relay orders raced', () => {
  const relayQuote = (orderId: Hex): CheckedQuote => ({
    ok: true,
    quoteId: `relay:${keccak256(toHex(String(Math.random())))}`,
    calls: [],
    quote: {
      provider: 'relay',
      inputAmount: '1000000',
      expectedOutputAmount: '990000',
      minOutputAmount: '980000',
      expectedFillTimeSec: 20,
      orderId,
      deadline: 2_000_000_000,
    },
  });

  it('given two swaps whose quotes hold the same order id, when both pass the lookup at once, then one holds it and the other is quote_rejected with order_reused', async () => {
    const orderId = keccak256(toHex(String(Math.random())));
    const [one, two] = [await connected(), await connected()];
    const ids = [orderId, orderId.toUpperCase().replace('0X', '0x') as Hex];
    checks.relay = () => relayQuote(ids.pop()!);
    lookups.meet = 2;

    const steps = await Promise.all([quoted(one), quoted(two)]);

    expect(lookups.waiting).toHaveLength(2);
    expect(steps.map((s) => s.row)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'quoting', quote: expect.objectContaining({ provider: 'relay' }) }),
        expect.objectContaining({ state: 'quote_rejected', code: 'order_reused', quoteId: null, quote: null }),
      ])
    );
  });
});

describe('the checks the quote runs', () => {
  const warnings = (logged: { mock: { calls: unknown[][] } }) =>
    logged.mock.calls.map(([line]) => JSON.parse(String(line))).filter((line) => line.level === 'warn');

  it('given another swap whose quote holds a Relay order id, when a quote is checked, then the order lookup passed to the checks finds it', async () => {
    const orderId = `0x${'cd'.repeat(32)}` as const;
    const other = await connected();
    const { row, token } = await claimed(other);
    await writeHeld(
      { connectionId: other.connectionId, id: row.id, token },
      {
        quoteId: `relay:0x${'ef'.repeat(32)}`,
        quote: { provider: 'relay', orderId },
        call: [],
        quoteFenced: '<<fenced quote>>',
        quotedAt: new Date(),
      }
    );

    await quoted(await connected());

    expect(await checks.deps!.isOrderTaken(orderId)).toBe(true);
    expect(await checks.deps!.isOrderTaken(`0x${'12'.repeat(32)}` as const)).toBe(false);
  });

  it('given a quote, when it is checked, then the clock passed to the checks reads unix seconds', async () => {
    const before = Math.floor(Date.now() / 1000);

    await quoted(await connected());

    const now = checks.deps!.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it.each(['solver_unknown', 'router_mismatch'])(
    'given the checks refuse the quote with %s, when the quote is asked, then the row is quote_rejected and a warning names only the provider, the chains and the code',
    async (code) => {
      const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      checks.code = code;

      const { row } = await quoted(await connected());

      expect(row).toMatchObject({ state: 'quote_rejected', code, call: null });
      expect(warnings(logged)).toEqual([
        {
          level: 'warn',
          time: expect.any(String),
          msg: 'swap quote refused on allowlist drift',
          provider: 'aurora',
          originChainId: 84532,
          destinationChainId: 42161,
          code,
        },
      ]);
    }
  );

  function driftedRelay(account: Address) {
    const ours = JSON.stringify(relayUsdc).replaceAll(/6ca44a56b06869530c953dfa7868973be1456769/gi, account.slice(2));
    const answer = JSON.parse(ours) as typeof relayUsdc;
    const order = answer.result.data.relayOrder.orderData;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    order.solver = '0x3333333333333333333333333333333333333333';
    order.output.deadline = deadline;
    for (const refund of order.inputs[0].refunds) refund.deadline = deadline;
    answer.result.data.relayOrder.orderId = relayOrderId(order)!;
    return answer;
  }

  it('given relay enabled and a Relay quote from a solver missing from the allowlist, when the quote is asked, then the real checks refuse it with solver_unknown and a warning names relay and the chains', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    config().swapProviders = ALL_PROVIDERS;
    const t = await connected();
    backend.answer = driftedRelay(t.account);
    const swap = { ...input, originChainId: 8453, originToken: BASE_USDC, amount: '10000000' };

    const step = await quote(t, await claimed(t, 'agent-key', swap), deps());

    expect(step).toMatchObject({ row: { state: 'quote_rejected', code: 'solver_unknown', call: null } });
    expect(warnings(logged)).toEqual([
      {
        level: 'warn',
        time: expect.any(String),
        msg: 'swap quote refused on allowlist drift',
        provider: 'relay',
        originChainId: 8453,
        destinationChainId: 42161,
        code: 'solver_unknown',
      },
    ]);
  });

  it('given the checks refuse the quote with tx_to, when the quote is asked, then no warning is logged', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    checks.code = 'tx_to';

    const { row } = await quoted(await connected());

    expect(row).toMatchObject({ state: 'quote_rejected', code: 'tx_to' });
    expect(warnings(logged)).toEqual([]);
  });
});
