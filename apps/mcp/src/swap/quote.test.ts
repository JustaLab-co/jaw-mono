import type { ChainClients, TopUpExecutor } from '@jaw.id/agent';
import { eq, sql } from 'drizzle-orm';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import {
  approvedOnChain,
  connect,
  fakeWallet,
  offlineSession,
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, payments, swaps } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { currentGrant } from '@/grants/store';
import type { PayDeps } from '@/payments/pay';
import { requestBudget } from '@/tools/request-budget';
import { quote, swapRequest, type SwapInput } from './quote';
import { claimSwap, type SwapRow } from './store';

const USDC: Record<number, Address> = {
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';

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

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () => node as unknown as PublicClient,
}));

setTestEnv();
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';

const balances = new Map<string, bigint>();
const balanceOf = (a: string) => balances.get(a.toLowerCase()) ?? 0n;
const node = {
  getCode: async () => undefined,
  getBlockNumber: async () => 77n,
  readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    if (functionName === 'balanceOf') return balanceOf(args[0] as string);
    if (functionName === 'allowance') return 0n;
    if (functionName === 'authorizationState') return false;
    throw new Error('this node only knows balances and nonces');
  },
  waitForTransactionReceipt: async () => {
    throw new Error('no receipt yet');
  },
  getBlock: async () => ({ timestamp: 1_790_000_000n }),
};
const clients: ChainClients = { publicClient: () => node as unknown as PublicClient };

const executor = (funder: Address): TopUpExecutor => ({
  request: async (method, params) => {
    if (method === 'wallet_getCallsStatus') return { status: 200 };
    const [{ calls }] = params as [{ calls: [{ data: Hex }] }];
    const [to, amount] = decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args as [Address, bigint];
    balances.set(to.toLowerCase(), balanceOf(to) + amount);
    balances.set(funder.toLowerCase(), balanceOf(funder) - amount);
    return { id: '0xbatch' };
  },
});

type Hit = { url: URL; key: string | null; nonce?: Hex };
type Answer = { status: number; data: unknown; error: unknown; receipt?: string };

const backend = {
  network: 'eip155:84532',
  price: '5000',
  mode: '' as '' | '422' | 'down' | 'reject' | 'invalid' | 'paid-502' | 'paid-203' | 'trailing-bytes' | 'huge',
  deposit: undefined as Address | undefined,
  loseNextAnswer: false,
  onPaid: undefined as (() => Promise<void>) | undefined,
  replays: new Map<string, Answer>(),
  spent: new Set<string>(),
  hits: [] as Hit[],
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const transfer = (to: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });

function envelope({ status, data, error, receipt }: Answer): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (receipt) headers['payment-response'] = receipt;
  return new Response(JSON.stringify({ statusCode: status, result: { data, error } }), { status, headers });
}

function auroraQuote(query: URLSearchParams, deposit: Address) {
  const amount = BigInt(query.get('amount')!);
  const out = amount - amount / 200n;
  const token = getAddress(query.get('originToken')!);
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
        to: token,
        data: transfer(deposit, amount),
        value: '0',
        description: 'deposit',
      },
    ],
  };
  if (backend.mode === 'trailing-bytes') quote.transactions[0].data += '00';
  return quote;
}

function challenge(url: URL): Response {
  const chainId = Number(backend.network.split(':')[1]);
  const required = {
    x402Version: 2,
    resource: { url: url.href },
    accepts: [
      {
        scheme: 'exact',
        network: backend.network,
        amount: backend.price,
        asset: USDC[chainId],
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
  return new Response('{}', { status: 402, headers: { 'payment-required': b64(required) } });
}

const quoteBackend: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const key = headers.get('idempotency-key');
  const signature = headers.get('payment-signature');
  const proof = signature ? JSON.parse(Buffer.from(signature, 'base64').toString()) : undefined;
  const nonce: Hex | undefined = proof?.payload.authorization.nonce;
  backend.hits.push({ url, key, nonce });
  if (backend.mode === '422') {
    return envelope({ status: 422, data: null, error: 'NoProviderAvailable: aurora=amount is too low for bridge' });
  }
  if (backend.mode === 'down' && !proof) return envelope({ status: 503, data: null, error: 'upstream unavailable' });
  const kept = key ? backend.replays.get(key) : undefined;
  if (kept) return envelope(kept);
  if (!proof || !nonce || backend.spent.has(nonce) || backend.mode === 'reject') return challenge(url);
  await backend.onPaid?.();
  backend.spent.add(nonce);
  const receipt = b64({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: backend.network });
  const deposit = backend.deposit ?? getAddress(`0x${keccak256(nonce).slice(-40)}`);
  let answer: Answer = { status: 200, data: auroraQuote(url.searchParams, deposit), error: null, receipt };
  if (backend.mode === 'invalid') answer = { status: 200, data: null, error: null, receipt };
  if (backend.mode === 'paid-502') answer = { status: 502, data: null, error: 'NoProviderAvailable', receipt };
  if (backend.mode === 'paid-203') answer = { ...answer, status: 203 };
  if (backend.mode === 'huge') answer = { ...answer, error: 'x'.repeat(17_000) };
  if (key) backend.replays.set(key, answer);
  if (backend.loseNextAnswer) {
    backend.loseNextAnswer = false;
    throw new TypeError('socket hang up');
  }
  return envelope(answer);
};

const deps = (): PayDeps => ({
  clients,
  floatTarget: 0n,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  executor: (_t, grant) => executor(grant.account),
  fetch: quoteBackend,
  later: () => undefined,
});

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  Object.assign(backend, {
    network: 'eip155:84532',
    price: '5000',
    mode: '',
    deposit: undefined,
    loseNextAnswer: false,
    onPaid: undefined,
  });
  lookups.meet = 0;
  lookups.waiting.length = 0;
  backend.replays.clear();
  backend.spent.clear();
  backend.hits.length = 0;
});

type Connected = { t: Tenant; budget: (perDay: string) => Promise<void> };

async function connected(perDay?: string): Promise<Connected> {
  const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));
  balances.set(c.signer.address.toLowerCase(), 5_000_000n);
  const budget = async (day: string) => {
    const wallet = fakeWallet(walletAnswers(c.signer));
    await requestBudget(t, day, { openWallet: wallet, readPermission: approvedOnChain, ...offlineSession });
    await walletsSettled();
    if (!(await currentGrant(t.connectionId))) throw new Error('no budget');
  };
  if (perDay) await budget(perDay);
  return { t, budget };
}

const input: SwapInput = {
  originChainId: 84532,
  originToken: USDC[84532],
  destinationChainId: 42161,
  destinationToken: ARB_USDC,
  amount: '1000000',
};

async function claimed(t: Tenant, key = 'agent-key') {
  const claim = await claimSwap(t.connectionId, key, swapRequest(t, input));
  if (claim.kind !== 'run') throw new Error(`claimed ${claim.kind}`);
  return claim;
}

async function quoted(t: Tenant, key = 'agent-key') {
  const step = await quote(t, await claimed(t, key), deps());
  if (step.kind !== 'done') throw new Error('the lease was lost');
  return step;
}

const swapOf = async (id: string): Promise<SwapRow> => (await getDb().select().from(swaps).where(eq(swaps.id, id)))[0];
const paymentsOf = (connectionId: string) =>
  getDb().select().from(payments).where(eq(payments.connectionId, connectionId)).orderBy(payments.createdAt);
const failPayment = async (id: string) => {
  await getDb().execute(sql`alter table payments disable trigger payments_guard`);
  await getDb().update(payments).set({ state: 'failed', finishedAt: new Date() }).where(eq(payments.id, id));
  await getDb().execute(sql`alter table payments enable trigger payments_guard`);
};
const paidHits = () => backend.hits.filter((h) => h.nonce);
const signatures = () => new Set(paidHits().map((h) => h.nonce)).size;

describe('the quote request', () => {
  it('given no recipient, when the request is built, then the account is both depositor and recipient, hex in lowercase', async () => {
    const { t } = await connected();
    expect(swapRequest(t, input)).toEqual({
      originChainId: 84532,
      originToken: USDC[84532].toLowerCase(),
      destinationChainId: 42161,
      destinationToken: ARB_USDC,
      amount: '1000000',
      depositor: t.account.toLowerCase(),
      recipient: t.account.toLowerCase(),
    });
  });

  it('given a recipient, when the request is built, then it is kept and the depositor is still the account', async () => {
    const { t } = await connected();
    const recipient = 'So11111111111111111111111111111111111111112';
    expect(swapRequest(t, { ...input, recipient })).toMatchObject({ depositor: t.account.toLowerCase(), recipient });
  });

  it('given a valid pair, when the quote is bought, then the backend is asked from config with the stored input and the swap key', async () => {
    const { t } = await connected('1');
    const { row } = await quoted(t);

    const [probe, paid] = backend.hits;
    expect(`${probe.url.origin}${probe.url.pathname}`).toBe(`${config().swapUrl}/swap/quote`);
    expect(Object.fromEntries(probe.url.searchParams)).toEqual({
      originChainId: '84532',
      destinationChainId: '42161',
      originToken: USDC[84532].toLowerCase(),
      destinationToken: ARB_USDC,
      amount: '1000000',
      depositor: t.account.toLowerCase(),
      recipient: t.account.toLowerCase(),
      tradeType: 'EXACT_INPUT',
    });
    expect(paid.url.href).toBe(probe.url.href);
    const [payment] = await paymentsOf(t.connectionId);
    expect(payment).toMatchObject({ idempotencyKey: `swap:${row.id}:1`, authorized: '5000' });
  });
});

describe('a paid quote', () => {
  it('given a valid pair, when the quote is bought, then the row holds the checked quote, its call, the payment and when it was signed', async () => {
    const { t } = await connected('1');
    const claim = await claimed(t);
    const step = await quote(t, claim, deps());

    const [payment] = await paymentsOf(t.connectionId);
    const deposit = getAddress(`0x${keccak256(paidHits()[0].nonce!).slice(-40)}`);
    expect(step).toMatchObject({ kind: 'done' });
    expect(await swapOf(claim.row.id)).toMatchObject({
      state: 'quoting',
      code: null,
      quoteId: `aurora:${deposit}`,
      depositAddress: deposit,
      call: { chainId: 84532, to: getAddress(USDC[84532]), data: transfer(deposit, 1_000_000n), value: '0' },
      quote: { inputAmount: '1000000', expectedOutputAmount: '995000', minOutputAmount: '990025' },
      paymentId: payment.id,
      paidAt: payment.signedAt,
      leaseToken: claim.token,
    });
    expect((await swapOf(claim.row.id)).quoteFenced).toContain(`aurora:${deposit}`);
    expect(payment.state).toMatch(/^(signed|settled)$/);
    expect(signatures()).toBe(1);
  });

  it('given a row already holding its checked quote, when the quote step runs again, then nothing is asked or paid and the row is unchanged', async () => {
    const { t } = await connected('1');
    const claim = await claimed(t);
    const first = await quote(t, claim, deps());
    if (first.kind !== 'done') throw new Error('the lease was lost');
    const hits = backend.hits.length;

    const again = await quote(t, { row: first.row, token: claim.token }, deps());

    expect(again).toEqual({ kind: 'done', row: first.row });
    expect(backend.hits).toHaveLength(hits);
    expect(await swapOf(claim.row.id)).toEqual(first.row);
  });

  it('given a deposit address another swap row already holds, when the quote is bought, then the swaps store refuses it as deposit_address_reused', async () => {
    const first = await connected('1');
    const held = await quoted(first.t);
    const second = await connected('1');
    backend.deposit = held.row.depositAddress as Address;

    const { row } = await quoted(second.t);

    expect(row).toMatchObject({ state: 'quote_rejected', code: 'deposit_address_reused', quoteId: null });
  });

  it('given another recipient and a quote whose deposit address is the account, when the quote is bought, then quote_rejected with deposit_address', async () => {
    const { t } = await connected('1');
    backend.deposit = t.account;
    const recipient = '0x4444444444444444444444444444444444444444';
    const claim = await claimSwap(t.connectionId, 'agent-key', swapRequest(t, { ...input, recipient }));
    if (claim.kind !== 'run') throw new Error(`claimed ${claim.kind}`);

    const step = await quote(t, claim, deps());

    expect(step).toMatchObject({ kind: 'done', row: { state: 'quote_rejected', code: 'deposit_address' } });
  });

  it('given a deposit whose calldata has trailing bytes, when the quote is bought, then quote_rejected with tx_data and the payment kept as paid', async () => {
    const { t } = await connected('1');
    backend.mode = 'trailing-bytes';

    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quote_rejected', code: 'tx_data', quoteId: null, call: null });
    const [payment] = await paymentsOf(t.connectionId);
    expect(payment).toMatchObject({ kind: 'paid', state: expect.stringMatching(/^(signed|settled)$/) });
    expect(row.paymentId).toBe(payment.id);
  });
});

describe('quote_failed codes', () => {
  it('B1: given a connection on 84532 and a 402 advertising eip155:8453, when the quote is bought, then wrong_chain naming both networks, one unpaid request, nothing signed', async () => {
    const { t } = await connected('1');
    backend.network = 'eip155:8453';

    const step = await quoted(t);

    expect(step.row).toMatchObject({ state: 'quote_failed', code: 'wrong_chain', quoteId: null });
    expect(step.payment?.structuredContent?.response?.join('\n')).toMatch(/eip155:8453[\s\S]*eip155:84532/);
    expect(backend.hits).toHaveLength(1);
    expect(paidHits()).toHaveLength(0);
    const [payment] = await paymentsOf(t.connectionId);
    expect(payment).toMatchObject({ state: 'pending', signedAt: null, nonce: null });

    expect(await claimSwap(t.connectionId, 'agent-key', swapRequest(t, input))).toMatchObject({ kind: 'stored' });
    expect(backend.hits).toHaveLength(1);
  });

  it('B6: given the backend refuses the pair before charging (422), when the quote is bought, then quote_unavailable, the reason fenced, nothing paid', async () => {
    const { t } = await connected('1');
    backend.mode = '422';

    const step = await quoted(t);

    expect(step.row).toMatchObject({ state: 'quote_failed', code: 'quote_unavailable' });
    expect(step.row.quoteFenced).toMatch(/^\[untrusted text from [^\]]+\][\s\S]*NoProviderAvailable/);
    const [payment] = await paymentsOf(t.connectionId);
    expect(payment).toMatchObject({ kind: 'free', state: 'settled', httpStatus: 422, nonce: null });
    expect(paidHits()).toHaveLength(0);
  });

  it.each([
    ['answers 200 with no quote', 'invalid'],
    ['answers 502 with its receipt', 'paid-502'],
    ['answers a quote with a 203 rather than a 200', 'paid-203'],
    ['answers a body over 16384 bytes, so no raw body is kept', 'huge'],
  ] as const)(
    'B7: given the backend charged and %s, when the quote is bought, then quote_invalid, and the same key returns it without paying again',
    async (_, mode) => {
      const { t } = await connected('1');
      backend.mode = mode;

      const { row } = await quoted(t);

      expect(row).toMatchObject({ state: 'quote_failed', code: 'quote_invalid', quoteId: null });
      expect(signatures()).toBe(1);
      const [payment] = await paymentsOf(t.connectionId);
      expect(row.paymentId).toBe(payment.id);
      const hits = backend.hits.length;
      expect(await claimSwap(t.connectionId, 'agent-key', swapRequest(t, input))).toMatchObject({
        kind: 'stored',
        row: { id: row.id, state: 'quote_failed', code: 'quote_invalid' },
      });
      expect(backend.hits).toHaveLength(hits);
    }
  );

  it('B29: given a quote whose paid answer was lost, when the same key resends to a replica that never kept it, then quote_lost and no second signature', async () => {
    const { t } = await connected('1');
    backend.loseNextAnswer = true;
    const lost = await quoted(t);
    expect(lost.row).toMatchObject({ state: 'quoting', code: 'no_response' });
    backend.replays.clear();

    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quote_failed', code: 'quote_lost', quoteId: null });
    expect(paidHits()).toHaveLength(2);
    expect(signatures()).toBe(1);
    expect(await paymentsOf(t.connectionId)).toHaveLength(1);
  });

  it('B29: given a quote whose paid answer was lost, when the same key resends to the replica that kept it, then the quote is held and paid once', async () => {
    const { t } = await connected('1');
    backend.loseNextAnswer = true;
    await quoted(t);

    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: null, quoteId: expect.stringMatching(/^aurora:0x/) });
    expect(paidHits()[1].key).toBe(paidHits()[0].key);
    expect(signatures()).toBe(1);
  });
});

describe('payment attempts', () => {
  it('B3: given a budget with less than 5000 left today, when the quote is bought, then quoting with budget_exhausted and nothing signed; after a larger budget the same key pays as attempt 2', async () => {
    const { t, budget } = await connected('0.004');

    const short = await quoted(t);

    expect(short.row).toMatchObject({ state: 'quoting', code: 'budget_exhausted', paymentAttempt: 1 });
    expect(short.payment?.structuredContent?.refusal).toEqual({ code: 'budget_exhausted', next: 'jaw_request_budget' });
    expect(short.row.paymentId).toBe(short.payment?.structuredContent?.paymentId);
    expect(paidHits()).toHaveLength(0);

    await budget('1');
    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: null, paymentAttempt: 2, paymentKey: `swap:${row.id}:2` });
    expect(row.quoteId).toMatch(/^aurora:0x/);
    const rows = await paymentsOf(t.connectionId);
    expect(rows.map((p) => [p.idempotencyKey, p.state])).toEqual([
      [`swap:${row.id}:1`, 'failed'],
      [`swap:${row.id}:2`, expect.stringMatching(/^(signed|settled)$/)],
    ]);
    expect(row.paymentId).toBe(rows[1].id);
    expect(signatures()).toBe(1);
  });

  it('given a backend asking more than 5000 for the quote, when the quote is bought, then over_cap and nothing signed, whatever the budget', async () => {
    const { t } = await connected('1');
    backend.price = '5001';

    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: 'over_cap', quoteId: null });
    expect(paidHits()).toHaveLength(0);
  });

  it('given no budget on the connection, when the quote is bought, then quoting with no_grant and the key free to retry at once', async () => {
    const { t } = await connected();

    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: 'no_grant', paymentAttempt: 1 });
    expect(backend.hits).toHaveLength(0);
    expect((await claimSwap(t.connectionId, 'agent-key', swapRequest(t, input))).kind).toBe('run');
  });

  it('B17: given a crash after the quote was paid and before the swap kept it, when the lease lapses and the key returns, then the stored payment replays its body and the quote is held, paid once', async () => {
    const { t } = await connected('1');
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

    expect(row).toMatchObject({ id: first.row.id, state: 'quoting', paymentAttempt: 1 });
    expect(row.quoteId).toMatch(/^aurora:0x/);
    expect(paidHits()).toHaveLength(1);
    expect(await paymentsOf(t.connectionId)).toHaveLength(1);
  });
});

describe('answers that leave the swap quoting', () => {
  it('given the seller rejects the first signed proof (402), when the quote is bought, then quoting with settlement_rejected and its payment; once that payment fails, the same key pays as attempt 2', async () => {
    const { t } = await connected('1');
    backend.mode = 'reject';

    const rejected = await quoted(t);

    const [payment] = await paymentsOf(t.connectionId);
    expect(rejected.row).toMatchObject({
      state: 'quoting',
      code: 'settlement_rejected',
      paymentId: payment.id,
      leaseToken: null,
    });
    expect(payment).toMatchObject({ state: 'unknown', httpStatus: 402 });

    backend.mode = '';
    await failPayment(payment.id);
    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: null, paymentAttempt: 2 });
    expect(row.quoteId).toMatch(/^aurora:0x/);
  });

  it('B29: given a lost answer, when the resend is lost too, then quoting with no_response and the same proof sent again', async () => {
    const { t } = await connected('1');
    backend.loseNextAnswer = true;
    await quoted(t);
    backend.replays.clear();
    backend.spent.clear();
    backend.loseNextAnswer = true;

    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: 'no_response', quoteId: null });
    expect(paidHits()).toHaveLength(2);
    expect(signatures()).toBe(1);
  });

  it('B29: given a lost answer and a budget replaced since, when the same key returns, then quoting with no_grant and the proof not sent again', async () => {
    const { t, budget } = await connected('1');
    backend.loseNextAnswer = true;
    await quoted(t);
    await budget('2');

    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: 'no_grant', quoteId: null });
    expect(paidHits()).toHaveLength(1);
  });

  it('given the backend answers 503 before charging, when the quote is bought, then quoting with backend_unavailable; the same key asks again as attempt 2', async () => {
    const { t } = await connected('1');
    backend.mode = 'down';

    const down = await quoted(t);

    const [payment] = await paymentsOf(t.connectionId);
    expect(down.row).toMatchObject({ state: 'quoting', code: 'backend_unavailable', paymentId: payment.id });
    expect(paidHits()).toHaveLength(0);

    backend.mode = '';
    const { row } = await quoted(t);

    expect(row).toMatchObject({ state: 'quoting', code: null, paymentAttempt: 2 });
    expect(row.quoteId).toMatch(/^aurora:0x/);
  });

  it('given a token without x402:pay, when the quote is bought, then quoting with insufficient_scope, the lease released and nothing asked', async () => {
    const { t } = await connected('1');
    const claim = await claimed(t);

    const step = await quote({ ...t, scopes: ['wallet:read'] }, claim, deps());

    expect(step).toMatchObject({
      kind: 'done',
      row: { state: 'quoting', code: 'insufficient_scope', leaseToken: null },
    });
    expect(backend.hits).toHaveLength(0);
    expect(await paymentsOf(t.connectionId)).toHaveLength(0);
  });
});

describe('inputs checked before paying', () => {
  it('given an origin token that is not an address, when the quote is bought, then quote_failed with invalid_request, nothing asked or paid', async () => {
    const { t } = await connected('1');
    const request = swapRequest(t, { ...input, originToken: '0xnot-a-token' as Address });
    const claim = await claimSwap(t.connectionId, 'agent-key', request);
    if (claim.kind !== 'run') throw new Error(`claimed ${claim.kind}`);

    const step = await quote(t, claim, deps());

    expect(step).toMatchObject({ kind: 'done', row: { state: 'quote_failed', code: 'invalid_request' } });
    expect(backend.hits).toHaveLength(0);
    expect(await paymentsOf(t.connectionId)).toHaveLength(0);
  });
});

describe('leases', () => {
  it('given the lease lapses and another call takes the swap while the quote is paid, when the payment ends, then lease_lost; the new holder keeps the paid quote without paying again', async () => {
    const { t } = await connected('1');
    const first = await claimed(t);
    let second: Awaited<ReturnType<typeof claimed>> | undefined;
    backend.onPaid = async () => {
      backend.onPaid = undefined;
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

    expect(step).toMatchObject({
      kind: 'done',
      row: { paymentAttempt: 1, quoteId: expect.stringMatching(/^aurora:0x/) },
    });
    expect(signatures()).toBe(1);
    expect(await paymentsOf(t.connectionId)).toHaveLength(1);
  });
});

describe('deposit addresses raced', () => {
  it('given two swaps whose quotes name the same deposit address, when both are bought at once, then one holds it and the other is quote_rejected with deposit_address_reused', async () => {
    const one = await connected('1');
    const two = await connected('1');
    backend.deposit = '0x5555555555555555555555555555555555555555';
    lookups.meet = 2;

    const steps = await Promise.all([quoted(one.t), quoted(two.t)]);

    expect(steps.map((s) => s.row)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'quoting', depositAddress: backend.deposit }),
        expect.objectContaining({ state: 'quote_rejected', code: 'deposit_address_reused', quoteId: null }),
      ])
    );
  });
});
