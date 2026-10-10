import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChainClients, GrantRequest, TopUpExecutor } from '@jaw.id/agent';
import { eq, sql } from 'drizzle-orm';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideFromPage, readForPage } from '@/approvals/page-api';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { revokeFromPage, type PageDeps, type PageOutcome } from '@/connections/page';
import { endConnection } from '@/connections/rows';
import { callTool, connect, pageProof, setTestEnv, verifyLocally } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { payments, settings } from '@/db/schema';
import {
  lockWaiters,
  statusOnceParked,
  TEST_PG_URL,
  useTestDb,
  useTestPostgres,
  withRoleStatementTimeout,
} from '@/db/test-db';
import { safeFetch } from '@/lib/safe-fetch';
import { pay, type PayDeps } from './pay';
import { withFloat } from './float-lock';
import { SEND_RESERVE_MS, stillHeld } from './refill';
import { claim, holdingRows, PAY_LIMIT_MS } from './store';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const AUTHORIZATION_USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);

const PRICES: Record<string, string> = {
  '/exact': '5000',
  '/lost': '5000',
  '/slow': '5000',
  '/refuse': '5000',
  '/unconfirmed': '5000',
  '/sametx': '5000',
  '/race': '5000',
  '/upto': '5000',
  '/budget': '300000',
  '/forever': '5000',
  '/overflow': '5000',
};
/** What the seller advertises as maxTimeoutSeconds, where it is not 300. */
const TIMEOUTS: Record<string, number> = {
  '/forever': 10 * 365 * 86_400,
  '/overflow': Number.MAX_SAFE_INTEGER,
};
const seen: { path: string; nonce: Hex; signature: Hex; validBefore: string }[] = [];
const receipts = new Map<Hex, { from: Address; nonce: Hex }>();
/** Nonces the token has consumed: the seller settled them on chain. */
const used = new Set<string>();
let dropNextLost = true;
/** Runs when the seller sees the request: on the probe before the refill, or on the signed proof after it. */
const onProbe = new Map<string, () => Promise<void>>();
const onProof = new Map<string, () => Promise<void>>();

const seller = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://seller').pathname;
  const signed = req.headers['payment-signature'];
  if (path === '/free') return void res.end('hello');
  if (!signed) {
    await onProbe.get(path)?.();
    const challenge = {
      x402Version: 2,
      resource: { url: `http://${req.headers.host}${path}` },
      accepts: [
        {
          scheme: path === '/upto' ? 'upto' : 'exact',
          network: 'eip155:84532',
          amount: PRICES[path],
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: TIMEOUTS[path] ?? 300,
          extra: { name: 'USDC', version: '2', facilitatorAddress: PAY_TO },
        },
      ],
    };
    return void res
      .writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') })
      .end('{}');
  }
  const proof = JSON.parse(Buffer.from(String(signed), 'base64').toString());
  const { nonce, from, validBefore } = proof.payload.authorization;
  await onProof.get(path)?.();
  const n = seen.push({ path, nonce, signature: proof.payload.signature, validBefore });
  if (path === '/budget') {
    used.add(nonce.toLowerCase());
    balances.set(from.toLowerCase(), balanceOf(from) - BigInt(PRICES[path]));
  }
  if (path === '/refuse' && seen.filter((s) => s.path === '/refuse').length > 1) {
    return void res.writeHead(402, { 'payment-required': Buffer.from('{}').toString('base64') }).end('{}');
  }
  if ((path === '/lost' || path === '/refuse') && dropNextLost) {
    dropNextLost = false;
    return void req.socket.destroy();
  }
  if (path === '/slow') await new Promise((r) => setTimeout(r, 100));
  // Settles on chain, but names no transaction the server can read back yet.
  if (path === '/unconfirmed') {
    used.add(nonce.toLowerCase());
    balances.set(from.toLowerCase(), balanceOf(from) - BigInt(PRICES[path]));
    return void res.end('{}');
  }
  const tx = path === '/sametx' ? TX(999) : TX(n);
  receipts.set(tx, { from, nonce });
  const receipt = { success: true, transaction: tx, network: 'eip155:84532', payer: from };
  res
    .writeHead(200, { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') })
    .end(JSON.stringify({ report: 'the weather is fine' }));
});
await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r));
const SELLER = `127.0.0.1:${(seller.address() as AddressInfo).port}`;

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () => node as unknown as PublicClient,
}));

setTestEnv();
process.env.JAW_MCP_INSECURE_FETCH_HOSTS = SELLER;
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';

const balances = new Map<string, bigint>();
const balanceOf = (a: string) => balances.get(a.toLowerCase()) ?? 0n;
const reads: { functionName: string; blockNumber?: bigint }[] = [];
const node = {
  getCode: async () => undefined,
  getBlockNumber: async () => 77n,
  readContract: async ({
    functionName,
    args,
    blockNumber,
  }: {
    functionName: string;
    args: readonly unknown[];
    blockNumber?: bigint;
  }) => {
    reads.push({ functionName, blockNumber });
    if (functionName === 'balanceOf') return balanceOf(args[0] as string);
    if (functionName === 'allowance') return 0n;
    if (functionName === 'authorizationState') return used.has(String(args[1]).toLowerCase());
    throw new Error('this node only knows balances and nonces');
  },
  waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    const paid = receipts.get(hash);
    if (!paid) throw new Error('no receipt');
    return {
      status: 'success',
      blockNumber: 7n,
      logs: [
        {
          address: USDC,
          topics: encodeEventTopics({
            abi: AUTHORIZATION_USED,
            eventName: 'AuthorizationUsed',
            args: { authorizer: paid.from, nonce: paid.nonce },
          }),
          data: encodeAbiParameters([], []),
        },
      ],
    };
  },
  getBlock: async () => ({ timestamp: 1_790_000_000n }),
};
const clients: ChainClients = { publicClient: () => node as unknown as PublicClient };

const refills: bigint[] = [];
const executor = (funder: Address): TopUpExecutor => ({
  request: async (method, params) => {
    if (method === 'wallet_getCallsStatus') return { status: 200 };
    const [{ calls }] = params as [{ calls: [{ data: Hex }] }];
    const { args } = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    const [to, amount] = args as [Address, bigint];
    refills.push(amount);
    balances.set(to.toLowerCase(), balanceOf(to) + amount);
    balances.set(funder.toLowerCase(), balanceOf(funder) - amount);
    return { id: `0xbatch${refills.length}` };
  },
});

const deps = (over: Partial<PayDeps> = {}): PayDeps => ({
  clients,
  floatTarget: 0n,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  executor: (_t, grant) => executor(grant.account),
  fetch: safeFetch(new Set([SELLER])),
  ...over,
});

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  seen.length = 0;
  refills.length = 0;
  onProbe.clear();
  onProof.clear();
});

async function connected(perDay?: string) {
  const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  if (perDay) await approveBudget(c, perDay);
  return { c, t };
}

async function approveBudget(c: Awaited<ReturnType<typeof connect>>, perDay: string) {
  {
    const asked = await callTool(c.access_token, 'jaw_request_budget', { perDay });
    const id = asked.structuredContent.requestId as string;
    const read = await readForPage(id);
    if (read.kind !== 'ok' || read.view.approve.type !== 'grant') throw new Error('no budget view');
    const grant: GrantRequest = read.view.approve.grant;
    const permission = {
      permissionId: `0x${Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64)}`,
      account: grant.address,
      spender: grant.spender,
      start: 1_780_000_000,
      end: grant.expiry,
      salt: '0x1',
      calls: [{ target: USDC, selector: '0xa9059cbb' }],
      spends: grant.permissions.spends,
    };
    const decided = await decideFromPage(
      id,
      { verdict: 'approved', previewHash: read.view.previewHash, permission },
      verifyLocally,
      new Date(),
      async () => ({ status: 'ok', approved: true, revoked: false })
    );
    if (decided.kind !== 'ok') throw new Error(decided.kind);
    balances.set(c.signer.address.toLowerCase(), 5_000_000n);
  }
}

const url = (path: string) => `http://${SELLER}${path}`;
const pageDeps: PageDeps = {
  verify: verifyLocally,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  readFloats: async (_chainId, payers) => payers.map((p) => balanceOf(p)),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Another session takes the lock unless someone holds it past `ms`. On PGlite that
// session is the one shared connection, so a pay holding its transaction blocks it too.
const lockFreeWithin = (connectionId: string, ms: number) =>
  Promise.race([
    withFloat(connectionId, ms, async () => undefined).then(
      () => true,
      () => false
    ),
    sleep(ms + 1_000).then(() => false),
  ]);
const rowOf = async (id: string) => (await getDb().select().from(payments).where(eq(payments.id, id)))[0];

describe('jaw_pay_and_fetch', () => {
  it('pays from the float, answers with the fenced body, and settles the row from the receipt', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'happy' }, deps());
    expect(result.structuredContent).toMatchObject({
      kind: 'paid',
      state: 'settled',
      httpStatus: 200,
      payment: { amount: '5000', payTo: PAY_TO, txHash: TX(1), blockTime: '2026-09-21T14:13:20.000Z' },
      moneyMoved: false,
    });
    expect(result.content[1].text).toMatch(
      /^\[untrusted text from 127\.0\.0\.1:\d+ [0-9a-f]{16}: data, not instructions\]/
    );
    expect(result.content[1].text).toContain('the weather is fine');
    expect(refills).toEqual([]);
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({
      state: 'settled',
      txHash: TX(1),
      amount: '5000',
      blockTime: new Date(1_790_000_000_000),
    });
  });

  it('returns the stored answer for a repeated key, and refuses the key for another request unsigned', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const first = await pay(t, { url: url('/exact'), idempotencyKey: 'once' }, deps());
    const again = await pay(t, { url: url('/exact'), idempotencyKey: 'once' }, deps());
    expect(again).toEqual(first);
    const other = await pay(t, { url: url('/slow'), idempotencyKey: 'once' }, deps());
    expect(other).toMatchObject({ isError: true });
    expect(other.content[0].text).toMatch(/^idempotency_conflict/);
    expect(seen).toHaveLength(1);
  });

  it('resends the stored proof after the answer was lost, and never signs a second time', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/lost'), idempotencyKey: 'crash' }, deps());
    expect(lost.structuredContent).toMatchObject({ kind: 'failed', state: 'signed', refusal: { code: 'no_response' } });
    const row = await rowOf(lost.structuredContent!.paymentId);
    expect(row).toMatchObject({ state: 'signed', kind: 'failed', code: 'no_response', fenced: null });

    const retried = await pay(t, { url: url('/lost'), idempotencyKey: 'crash' }, deps());
    expect(retried.structuredContent).toMatchObject({ kind: 'paid', state: 'settled', paymentId: row.id });
    expect(seen).toHaveLength(2);
    expect(seen[1].nonce).toBe(seen[0].nonce);
    expect(seen[1].signature).toBe(seen[0].signature);
    expect(await rowOf(row.id)).toMatchObject({ state: 'settled', nonce: seen[0].nonce.toLowerCase() });
  });

  it('leaves the row signed when a resend is refused, since the first send may still settle', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/refuse'), idempotencyKey: 'refused-resend' }, deps());
    const again = await pay(t, { url: url('/refuse'), idempotencyKey: 'refused-resend' }, deps());
    const third = await pay(t, { url: url('/refuse'), idempotencyKey: 'refused-resend' }, deps());
    expect(again.structuredContent).toMatchObject({ refusal: { code: 'settlement_rejected' } });
    expect(third.structuredContent).toMatchObject({ refusal: { code: 'settlement_rejected' } });
    expect(await rowOf(lost.structuredContent!.paymentId)).toMatchObject({ state: 'signed', code: 'no_response' });
  });

  it('never returns a refill error to the agent, which can quote the paymaster key', async () => {
    const { t } = await connected('1');
    const leaky: TopUpExecutor = {
      request: async () => {
        throw new Error('HTTP request failed.\n\nURL: https://paymaster.example/rpc?api-key=SECRET-KEY');
      },
    };
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'leak' }, deps({ executor: () => leaky }));
    expect(result.structuredContent).toMatchObject({ state: 'failed', refusal: { code: 'funding_failed' } });
    expect(JSON.stringify(result)).not.toContain('SECRET-KEY');
    expect(JSON.stringify(await rowOf(result.structuredContent!.paymentId))).not.toContain('SECRET-KEY');
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1:9/x',
    'https://[::ffff:10.0.0.1]/x',
  ])('refuses %s as blocked_url with nothing signed', async (target) => {
    const { t } = await connected('1');
    const result = await pay(t, { url: target, idempotencyKey: 'ssrf' }, deps());
    expect(result.structuredContent).toMatchObject({ state: 'failed', refusal: { code: 'blocked_url' } });
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ state: 'pending', nonce: null });
  });

  it('refills only the shortfall plus the gas reserve when the float is empty', async () => {
    const { t } = await connected('1');
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'refill' }, deps());
    expect(refills).toEqual([105_000n]);
    expect(result.structuredContent).toMatchObject({
      kind: 'paid',
      topUp: { amount: '105000', batchId: '0xbatch1' },
      moneyMoved: true,
    });
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ topUpAmount: '105000' });
  });

  it('given a seller advertising a ten year maxTimeoutSeconds, when it pays, then the proof and the row expire within the hour', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const before = Math.floor(Date.now() / 1000);
    const result = await pay(t, { url: url('/forever'), idempotencyKey: 'forever' }, deps());
    expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
    const validBefore = Number(seen.find((s) => s.path === '/forever')!.validBefore);
    expect(validBefore).toBeGreaterThanOrEqual(before + 3600);
    expect(validBefore).toBeLessThanOrEqual(Date.now() / 1000 + 3600);
    const row = await rowOf(result.structuredContent!.paymentId);
    expect(row.deadline!.getTime()).toBe(validBefore * 1000);
  });

  it('given a seller advertising the largest safe maxTimeoutSeconds, when it refills and pays, then the row records the payment', async () => {
    const { t } = await connected('1');
    const result = await pay(t, { url: url('/overflow'), idempotencyKey: 'overflow' }, deps());
    expect(refills).toEqual([105_000n]);
    expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled', moneyMoved: true });
    const row = await rowOf(result.structuredContent!.paymentId);
    expect(row.deadline!.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('holds no reservation while the refill waits on the chain, so a refill killed there leaves none', async () => {
    const { t } = await connected('1');
    const reservedDuringWait: (string | null)[] = [];
    const watching = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        const [row] = await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'chain-wait'));
        reservedDuringWait.push(row.reserved);
        return executor(funder).request(method, params);
      },
    });
    const result = await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'chain-wait' },
      deps({ executor: (_t, grant) => watching(grant.account) })
    );
    expect(result.structuredContent).toMatchObject({ kind: 'paid', moneyMoved: true });
    expect(reservedDuringWait.length).toBeGreaterThan(0);
    expect(reservedDuringWait.every((reserved) => reserved === null)).toBe(true);
  });

  it('refills to the float target, so the next payments need no refill', async () => {
    const { t } = await connected('1');
    await pay(t, { url: url('/exact'), idempotencyKey: 'float-1' }, deps({ floatTarget: 50_000n }));
    await pay(t, { url: url('/exact'), idempotencyKey: 'float-2' }, deps({ floatTarget: 50_000n }));
    expect(refills).toEqual([150_000n]);
  });

  it('gives five concurrent payments their own rows and one refill, with no lock held across a fetch', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 5_000n);
    const lockFree: boolean[] = [];
    onProof.set('/slow', async () => void lockFree.push(await lockFreeWithin(t.connectionId, 2_000)));
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => pay(t, { url: url('/slow'), idempotencyKey: `burst-${n}` }, deps()))
    );
    expect(new Set(results.map((r) => r.structuredContent?.paymentId)).size).toBe(5);
    expect(results.every((r) => r.structuredContent?.kind === 'paid')).toBe(true);
    expect(refills).toEqual([105_000n]);
    expect(lockFree).toEqual([true, true, true, true, true]);
  });

  it('reserves the float for concurrent payments even when the server cannot refill', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 5_000n);
    const results = await Promise.all(
      [1, 2].map((n) =>
        pay(t, { url: url('/slow'), idempotencyKey: `norefill-${n}` }, deps({ executor: () => undefined }))
      )
    );
    expect(results.map((r) => r.structuredContent?.kind).sort()).toEqual(['paid', 'refused']);
    expect(seen).toHaveLength(1);
    const refused = results.find((r) => r.structuredContent?.kind === 'refused');
    expect(await rowOf(refused!.structuredContent!.paymentId)).toMatchObject({ reserved: null });
  });

  it('counts what the previous budget pulled today against a lowered one, so 2 then 1 never pulls more than 2', async () => {
    const { c, t } = await connected('2');
    await pay(t, { url: url('/exact'), idempotencyKey: 'old-grant' }, deps({ floatTarget: 1_900_000n }));
    expect(refills).toEqual([2_000_000n]);
    balances.set(t.sessionAddress.toLowerCase(), 0n);
    await approveBudget(c, '1');
    const after = await pay(t, { url: url('/exact'), idempotencyKey: 'new-grant' }, deps());
    expect(after.structuredContent).toMatchObject({ refusal: { code: 'budget_exhausted' } });
    expect(refills).toEqual([2_000_000n]);
  });

  it('refuses past the daily budget as budget_exhausted, with the raise named and nothing sent', async () => {
    const { t } = await connected('0.006');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    await pay(t, { url: url('/exact'), idempotencyKey: 'day-1' }, deps());
    const over = await pay(t, { url: url('/exact'), idempotencyKey: 'day-2' }, deps());
    expect(over.structuredContent).toMatchObject({
      kind: 'refused',
      state: 'failed',
      refusal: { code: 'budget_exhausted', next: 'jaw_request_budget' },
      moneyMoved: false,
    });
    expect(seen).toHaveLength(1);
  });

  it('refuses with payments_paused first, writing no row', async () => {
    const { t } = await connected('1');
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });
    try {
      const result = await pay(t, { url: url('/exact'), idempotencyKey: 'paused' }, deps());
      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toMatch(/^payments_paused/);
      expect(await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'paused'))).toEqual([]);
    } finally {
      await getDb().delete(settings).where(eq(settings.key, 'payments_paused'));
    }
  });

  it.each([
    ['revoked on chain', { status: 'ok', approved: true, revoked: true }, 'grant_revoked'],
    ['not approved on chain', { status: 'ok', approved: false, revoked: false }, 'grant_revoked'],
    ['unreadable', { status: 'unavailable' }, 'chain_unavailable'],
  ] as const)('refuses before signing or refilling when the budget is %s', async (_name, state, code) => {
    const { t } = await connected('1');
    const result = await pay(t, { url: url('/exact') }, deps({ readPermission: async () => state }));
    expect(result.structuredContent).toMatchObject({ state: 'failed', refusal: { code } });
    expect(seen).toEqual([]);
    expect(refills).toEqual([]);
  });

  it('given a token with wallet:read wallet:send on a connection with a budget, when it pays, then it is refused insufficient_scope naming x402:pay', async () => {
    const { t } = await connected('1');
    const result = await pay(
      { ...t, scopes: ['wallet:read', 'wallet:send'] },
      { url: url('/exact'), idempotencyKey: 'no-pay-scope' },
      deps()
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/^insufficient_scope: This token was not granted x402:pay\./);
    expect(seen).toEqual([]);
    expect(refills).toEqual([]);
    expect(await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'no-pay-scope'))).toEqual([]);
  });

  it('given payments are paused, when a token without x402:pay pays, then the scope refusal comes first', async () => {
    const { t } = await connected('1');
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });
    try {
      const result = await pay({ ...t, scopes: ['wallet:read', 'wallet:send'] }, { url: url('/exact') }, deps());
      expect(result.content[0].text).toMatch(/^insufficient_scope: /);
    } finally {
      await getDb().delete(settings).where(eq(settings.key, 'payments_paused'));
    }
  });

  it('refuses a connection with no budget as no_grant, writing no row', async () => {
    const { t } = await connected();
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'none' }, deps());
    expect(result.content[0].text).toMatch(/^no_grant/);
    expect(seen).toEqual([]);
  });

  it('passes a free resource through as a settled free row', async () => {
    const { t } = await connected('1');
    const result = await pay(t, { url: url('/free') }, deps());
    expect(result.structuredContent).toMatchObject({ kind: 'free', state: 'settled', moneyMoved: false });
    expect(result.structuredContent?.idempotencyKey).toMatch(/^auto_/);
  });

  it('answers in_progress while another call holds the key, and takes over a lapsed one', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const request = { url: url('/exact'), method: 'GET' as const, headers: {} };
    const held = await claim(
      { connectionId: t.connectionId, payer: t.sessionAddress, permissionId: '0xgrant' },
      'held',
      request
    );
    if (held.kind !== 'run') throw new Error(held.kind);
    const busy = await pay(t, { url: url('/exact'), idempotencyKey: 'held' }, deps());
    expect(busy.content[0].text).toMatch(/^in_progress/);
    expect(seen).toEqual([]);

    await getDb().execute(sql`update payments set lease_until = now() - interval '1 second' where id = ${held.row.id}`);
    const taken = await pay(t, { url: url('/exact'), idempotencyKey: 'held' }, deps());
    expect(taken.structuredContent).toMatchObject({ paymentId: held.row.id, kind: 'paid', state: 'settled' });
  });

  it('does not hold a signed payment the chain already settled against the float, so no refill runs', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 10_000n);
    const first = await pay(t, { url: url('/unconfirmed'), idempotencyKey: 'used-1' }, deps());
    expect(first.structuredContent).toMatchObject({ state: 'signed', kind: 'paid' });
    const second = await pay(t, { url: url('/unconfirmed'), idempotencyKey: 'used-2' }, deps());
    expect(second.structuredContent).toMatchObject({ kind: 'paid', moneyMoved: false });
    expect(refills).toEqual([]);
  });

  it('refuses to settle a payment on a transaction hash another payment of the payer already settled on', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const first = await pay(t, { url: url('/sametx'), idempotencyKey: 'same-1' }, deps());
    const second = await pay(t, { url: url('/sametx'), idempotencyKey: 'same-2' }, deps());
    expect(first.structuredContent).toMatchObject({ state: 'settled', payment: { txHash: TX(999) } });
    expect(second.structuredContent).toMatchObject({ state: 'signed', kind: 'paid' });
    expect(second.structuredContent?.payment?.txHash).toBeUndefined();
  });

  it('reads the payer balance and the nonces it holds against at one block', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 10_000n);
    await pay(t, { url: url('/unconfirmed'), idempotencyKey: 'block-1' }, deps());
    reads.length = 0;
    await pay(t, { url: url('/unconfirmed'), idempotencyKey: 'block-2' }, deps());
    const nonce = reads.find((r) => r.functionName === 'authorizationState');
    const balance = reads.find((r) => r.functionName === 'balanceOf');
    expect(nonce?.blockNumber).toBe(77n);
    expect(balance?.blockNumber).toBe(77n);
  });

  it('holds a signed payment whose nonce is still unused, so the next one refills', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 5_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/lost'), idempotencyKey: 'unused-1' }, deps());
    expect(lost.structuredContent).toMatchObject({ state: 'signed', refusal: { code: 'no_response' } });
    await pay(t, { url: url('/exact'), idempotencyKey: 'unused-2' }, deps());
    expect(refills).toEqual([105_000n]);
  });

  it('stops holding an unknown payment once its deadline plus the reconciler margin passed', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 5_000n);
    dropNextLost = true;
    const rejected = await pay(t, { url: url('/refuse'), idempotencyKey: 'dead-1' }, deps());
    const id = rejected.structuredContent!.paymentId;
    await getDb().execute(sql`alter table payments disable trigger payments_guard`);
    await getDb().execute(
      sql`update payments set state = 'unknown', deadline = now() - interval '10 minutes' where id = ${id}`
    );
    await getDb().execute(sql`alter table payments enable trigger payments_guard`);
    await pay(t, { url: url('/exact'), idempotencyKey: 'dead-2' }, deps());
    expect(refills).toEqual([]);
  });

  it('keeps holding an unknown payment just past its deadline, inside the reconciler margin', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 5_000n);
    dropNextLost = true;
    const rejected = await pay(t, { url: url('/refuse'), idempotencyKey: 'margin-1' }, deps());
    const id = rejected.structuredContent!.paymentId;
    await getDb().execute(sql`alter table payments disable trigger payments_guard`);
    await getDb().execute(
      sql`update payments set state = 'unknown', deadline = now() - interval '1 minute' where id = ${id}`
    );
    await getDb().execute(sql`alter table payments enable trigger payments_guard`);
    await pay(t, { url: url('/exact'), idempotencyKey: 'margin-2' }, deps());
    expect(refills).toEqual([105_000n]);
  });

  it('lists payments newest first in jaw_history, scoped to the connection', async () => {
    const { c, t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    await pay(t, { url: url('/exact'), idempotencyKey: 'h1' }, deps());
    await pay(t, { url: url('/exact'), idempotencyKey: 'h2' }, deps());
    const listed = await callTool(c.access_token, 'jaw_history', { limit: 1 });
    expect(listed.structuredContent.payments).toHaveLength(1);
    expect(listed.structuredContent.payments[0]).toMatchObject({ idempotencyKey: 'h2', state: 'settled' });
    const next = await callTool(c.access_token, 'jaw_history', { limit: 5, before: listed.structuredContent.next });
    expect(next.structuredContent.payments.map((p: { idempotencyKey: string }) => p.idempotencyKey)).toEqual(['h1']);
    const stranger = await connected();
    expect((await callTool(stranger.c.access_token, 'jaw_history', {})).structuredContent.payments).toEqual([]);
  });
});

describe('given a pay request that verified its bearer before the connection was disconnected', () => {
  // What jaw_disconnect does once its batch landed: end the connection under the float lock.
  const disconnect = (t: Tenant, held?: bigint[]) => () =>
    withFloat(t.connectionId, 1_000, (hold) =>
      hold.tx(async (tx) => {
        if (held) held.push(await stillHeld(await holdingRows(tx, t.sessionAddress, randomUUID()), clients, 77n));
        await endConnection(t.connectionId, t.account, new Date(), tx);
      })
    );

  it('when its refill turn comes after the disconnect committed, then it refuses, reserves nothing and signs nothing', async () => {
    const { t } = await connected('1');
    onProbe.set('/race', disconnect(t));
    const result = await pay(t, { url: url('/race'), idempotencyKey: 'race-refill' }, deps());
    expect(result.structuredContent).toMatchObject({
      kind: 'refused',
      state: 'failed',
      moneyMoved: false,
      refusal: { code: 'not_allowed' },
    });
    expect(refills).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ reserved: null, nonce: null });
    expect(
      result.content
        .slice(1)
        .map((c) => c.text)
        .join('\n')
    ).not.toContain('this connection has ended');
  });

  it('when the disconnect commits after its refill, then its hold keeps the float for it and it settles', async () => {
    const { t } = await connected('1');
    const held: bigint[] = [];
    onProof.set('/race', disconnect(t, held));
    const result = await pay(t, { url: url('/race'), idempotencyKey: 'race-past-refill' }, deps());
    expect(held).toEqual([5_000n]);
    expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
    expect(refills).toEqual([105_000n]);
  });
});

describe('given a pay request that verified its bearer before the owner revoked it on the page', () => {
  it('when its refill turn comes after the revoke committed, then it refuses, reserves nothing and signs nothing', async () => {
    const { c, t } = await connected('1');
    onProbe.set('/race', async () => {
      expect((await revokeFromPage(t.connectionId, await pageProof(c.signer), pageDeps)).kind).toBe('ok');
    });
    const result = await pay(t, { url: url('/race'), idempotencyKey: 'page-race-refill' }, deps());
    expect(result.structuredContent).toMatchObject({
      kind: 'refused',
      moneyMoved: false,
      refusal: { code: 'not_allowed' },
    });
    expect(refills).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ reserved: null, nonce: null });
  });

  it('when the revoke commits after its refill, then the reply shows the refilled float and the pay still settles', async () => {
    const { c, t } = await connected('1');
    let revoked: PageOutcome | undefined;
    onProof.set('/race', async () => {
      revoked = await revokeFromPage(t.connectionId, await pageProof(c.signer), pageDeps);
    });
    const result = await pay(t, { url: url('/race'), idempotencyKey: 'page-race-past-refill' }, deps());
    expect(revoked).toMatchObject({ kind: 'ok', body: { status: 'revoked', float: '105000' } });
    expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
    expect(refills).toEqual([105_000n]);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a pay inside its funding turn', () => {
  it('when the owner revokes on the page, then the revoke waits for the turn, shows its refill, and the next pay refuses', async () => {
    const { c, t } = await connected('1');
    let revoking: Promise<PageOutcome> | undefined;
    let statusInTurn: string | undefined;
    const inTurn = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        if (!revoking) {
          revoking = revokeFromPage(t.connectionId, await pageProof(c.signer), pageDeps);
          statusInTurn = await statusOnceParked(t.connectionId);
        }
        return executor(funder).request(method, params);
      },
    });
    const paid = await pay(
      t,
      { url: url('/race'), idempotencyKey: 'page-in-turn' },
      deps({ executor: (_t, grant) => inTurn(grant.account) })
    );
    expect(statusInTurn).toBe('active');
    expect(paid.structuredContent).toMatchObject({ kind: 'paid' });
    expect(await revoking).toMatchObject({ kind: 'ok', body: { status: 'revoked', float: '105000' } });

    const after = await pay(t, { url: url('/race'), idempotencyKey: 'page-after-turn' }, deps());
    expect(after.structuredContent).toMatchObject({ kind: 'refused', refusal: { code: 'not_allowed' } });
    expect(refills).toEqual([105_000n]);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a disconnect that holds the float lock', () => {
  it('when a pay waits on that lock and the disconnect ends the connection, then the pay refuses and moves nothing', async () => {
    const { t } = await connected('1');
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    let parked = 0;
    const disconnecting = withFloat(t.connectionId, 1_000, async (hold) => {
      locked();
      for (let i = 0; i < 100 && parked === 0; i++) {
        await sleep(50);
        parked = await lockWaiters(t.connectionId);
      }
      await hold.tx((tx) => endConnection(t.connectionId, t.account, new Date(), tx));
    });
    await holding;
    const paying = pay(t, { url: url('/race'), idempotencyKey: 'race-lock' }, deps());
    await disconnecting;
    const result = await paying;
    expect(parked).toBe(1);
    expect(result.structuredContent).toMatchObject({
      kind: 'refused',
      moneyMoved: false,
      refusal: { code: 'not_allowed' },
    });
    expect(refills).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ reserved: null, nonce: null });
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given ten connections refilling at once', () => {
  it('when another tenant checks its bearer during their chain wait, then it answers in under 1 s and all ten pay', async () => {
    const payers = await Promise.all(Array.from({ length: 10 }, () => connected('1')));
    const bystander = await connected();
    let started = 0;
    const slow = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        if (method !== 'wallet_getCallsStatus') {
          started++;
          await sleep(4_000);
        }
        return executor(funder).request(method, params);
      },
    });
    const paying = Promise.all(
      payers.map(({ t }, i) =>
        pay(
          t,
          { url: url('/race'), idempotencyKey: `pool-${i}` },
          deps({ executor: (_t, grant) => slow(grant.account) })
        )
      )
    );
    for (let i = 0; i < 100 && started < 10; i++) await sleep(50);
    const t0 = Date.now();
    await verifyBearer(bystander.c.access_token);
    const waited = Date.now() - t0;
    const results = await paying;
    expect(started).toBe(10);
    expect(results.map((r) => r.structuredContent?.kind)).toEqual(Array(10).fill('paid'));
    expect(waited).toBeLessThan(1_000);
  });
});

describe('given a 1 USDC/day budget and 1.5 USDC already in the payer', () => {
  const payOne = (t: Tenant, key: string, payWith = pay) =>
    payWith(t, { url: url('/budget'), idempotencyKey: key }, deps());

  it('when six 0.3 payments run one after another, then three are paid and the rest refuse budget_exhausted', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_500_000n);
    const outcomes: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      const r = (await payOne(t, `budget-seq-${i}`)).structuredContent;
      outcomes.push(r?.kind === 'paid' ? 'paid' : r?.refusal?.code);
    }
    expect(outcomes).toEqual(['paid', 'paid', 'paid', 'budget_exhausted', 'budget_exhausted', 'budget_exhausted']);
  });

  it.skipIf(!TEST_PG_URL)(
    'when six 0.3 payments run at once across two replicas on Postgres, with each signature landing after the next turn, then three are paid, the rest refuse budget_exhausted holding nothing with a one-off offer, and jaw_status shows what is left',
    async () => {
      const { c, t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_500_000n);
      vi.resetModules();
      const replica = (await import('./pay')).pay;
      // Each signature lands after the next turn has read the caps, so only the reservation counts it.
      await getDb().execute(sql`create function slow_sign() returns trigger language plpgsql
        as $$ begin perform pg_sleep(0.3); return new; end $$`);
      await getDb().execute(sql`create trigger slow_sign before update on payments for each row
        when (old.state = 'pending' and new.state = 'signed') execute function slow_sign()`);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => payOne(t, `budget-burst-${i}`, i % 2 ? replica : pay))
      ).finally(() => getDb().execute(sql`drop function slow_sign cascade`));
      const refused = results.filter((r) => r.structuredContent?.kind !== 'paid');
      expect(refused.map((r) => r.structuredContent?.refusal?.code)).toEqual(Array(3).fill('budget_exhausted'));
      expect(refused.every((r) => r.structuredContent?.refusal?.oneOff?.requestId)).toBe(true);
      expect(seen).toHaveLength(3);
      for (const r of refused) {
        expect(await rowOf(r.structuredContent!.paymentId)).toMatchObject({ reserved: null, topUpAmount: null });
      }
      const status = await callTool(c.access_token, 'jaw_status', {});
      expect(status.structuredContent.balances.session.amount).toBe('600000');
    }
  );
});

describe.skipIf(!TEST_PG_URL)(
  'on Postgres, given a float that covers the price and a lock session that drops while the refill reads the balance',
  () => {
    it('when the turn ends with nothing to send, then it reserves nothing and the pay does not end paid', async () => {
      const { t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
      let dropped = false;
      const dropping: ChainClients = {
        publicClient: () =>
          ({
            ...node,
            readContract: async (read: Parameters<typeof node.readContract>[0]) => {
              if (read.functionName === 'balanceOf' && !dropped) {
                dropped = true;
                await getDb().execute(sql`select pg_terminate_backend(pid) from pg_locks
                where locktype = 'advisory' and granted
                  and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${t.connectionId}`})`);
                await sleep(200);
              }
              return node.readContract(read);
            },
          }) as unknown as PublicClient,
      };
      const result = await pay(
        t,
        { url: url('/race'), idempotencyKey: 'holder-dropped-covered' },
        deps({ clients: dropping })
      );
      expect(dropped).toBe(true);
      expect(result.structuredContent?.kind).not.toBe('paid');
      expect(seen).toHaveLength(0);
      expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ reserved: null });
    });
  }
);

describe.skipIf(!TEST_PG_URL)('on Postgres, given a refill whose lock session drops before it sends', () => {
  it('when the refill reaches the send, then it moves no money and the pay does not end paid', async () => {
    const { t } = await connected('1');
    let dropped = false;
    const dropping: ChainClients = {
      publicClient: () =>
        ({
          ...node,
          getBlockNumber: async () => {
            if (!dropped) {
              dropped = true;
              await getDb().execute(sql`select pg_terminate_backend(pid) from pg_locks
                where locktype = 'advisory' and granted
                  and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${t.connectionId}`})`);
              await sleep(200);
            }
            return node.getBlockNumber();
          },
        }) as unknown as PublicClient,
    };
    const result = await pay(t, { url: url('/race'), idempotencyKey: 'holder-dropped' }, deps({ clients: dropping }));
    expect(dropped).toBe(true);
    expect(result.structuredContent?.kind).not.toBe('paid');
    expect(refills).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe.skipIf(!TEST_PG_URL)(
  'on Postgres, given an exact refill whose lock session drops while the top-up confirms',
  () => {
    it('when the top-up landed, then the pay is refused unsigned with the top-up traced and nothing reserved', async () => {
      const { t } = await connected('1');
      let dropped = false;
      const dropping = (funder: Address): TopUpExecutor => ({
        request: async (method, params) => {
          if (method === 'wallet_getCallsStatus' && !dropped) {
            dropped = true;
            await getDb().execute(sql`select pg_terminate_backend(pid) from pg_locks
            where locktype = 'advisory' and granted
              and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${t.connectionId}`})`);
            await sleep(200);
          }
          return executor(funder).request(method, params);
        },
      });
      const result = await pay(
        t,
        { url: url('/race'), idempotencyKey: 'holder-dropped-exact' },
        deps({ executor: (_t, grant) => dropping(grant.account) })
      );
      expect(dropped).toBe(true);
      expect(refills).toHaveLength(1);
      expect(seen).toHaveLength(0);
      expect(result.structuredContent?.refusal?.code).toBe('funding_failed');
      expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({
        reserved: null,
        topUpAmount: refills[0].toString(),
      });
    });
  }
);

describe.skipIf(!TEST_PG_URL)(
  'on Postgres, given an upto refill whose lock session drops while the top-up confirms',
  () => {
    it('when the Permit2 approval comes next, then it is never sent and the pay does not end paid', async () => {
      const { t } = await connected('1');
      let dropped = false;
      const approvals: string[] = [];
      const dropping = (funder: Address): TopUpExecutor => ({
        request: async (method, params) => {
          if (method === 'wallet_getCallsStatus' && !dropped) {
            dropped = true;
            await getDb().execute(sql`select pg_terminate_backend(pid) from pg_locks
            where locktype = 'advisory' and granted
              and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${t.connectionId}`})`);
            await sleep(200);
          }
          return executor(funder).request(method, params);
        },
        approvePermit2: async (token) => {
          approvals.push(token);
          return '0xapproval';
        },
      });
      const result = await pay(
        t,
        { url: url('/upto'), idempotencyKey: 'holder-dropped-upto' },
        deps({ executor: (_t, grant) => dropping(grant.account) })
      );
      expect(dropped).toBe(true);
      expect(refills).toHaveLength(1);
      expect(approvals).toEqual([]);
      expect(result.structuredContent?.kind).not.toBe('paid');
    });
  }
);

describe.skipIf(!TEST_PG_URL)('on Postgres with a 1 s role statement_timeout', () => {
  beforeAll(() => withRoleStatementTimeout('1s'));

  // Another transaction holds the float lock until released, as a refill on another replica would.
  async function holdFloat(connectionId: string) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const done = withFloat(connectionId, 1_000, async () => {
      locked();
      await released;
    });
    await held;
    return () => {
      release();
      return done;
    };
  }

  async function parked(connectionId: string) {
    for (let i = 0; i < 100; i++) {
      if ((await lockWaiters(connectionId)) > 0) return;
      await sleep(50);
    }
    throw new Error('nothing waited on the float lock');
  }

  it('given another transaction holds the float lock past it, when a refill waits longer, then the pay refuses timed_out and logs no SQL', async () => {
    const { t } = await connected('1');
    const release = await holdFloat(t.connectionId);
    // The budget is a fixed 90 s: from the probe on, the clock jumps so the refill has about 8 s left to wait.
    const now = Date.now;
    let skipped = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + skipped);
    onProbe.set('/race', async () => {
      skipped = PAY_LIMIT_MS - SEND_RESERVE_MS - 8_000;
    });
    const logged = vi.spyOn(console, 'log');
    try {
      const paying = pay(t, { url: url('/race'), idempotencyKey: 'lock-timeout' }, deps());
      await parked(t.connectionId);
      expect((await paying).structuredContent).toMatchObject({
        kind: 'refused',
        moneyMoved: false,
        refusal: { code: 'timed_out' },
      });
      const lines = logged.mock.calls.flat().join('\n');
      expect(lines).toContain('payment timed_out: another payment on this connection held the refill too long');
      expect(lines).not.toContain(`refill:${t.connectionId}`);
      expect(lines).not.toContain('pg_advisory');
      expect(refills).toEqual([]);
      expect(seen).toHaveLength(0);
    } finally {
      clock.mockRestore();
      logged.mockRestore();
      await release();
    }
  });

  it('given another transaction holds the float lock past it, when the holder releases before the wait ends, then the refill runs and the pay settles', async () => {
    const { t } = await connected('1');
    const release = await holdFloat(t.connectionId);
    try {
      const paying = pay(t, { url: url('/race'), idempotencyKey: 'lock-released' }, deps());
      await parked(t.connectionId);
      await sleep(1_500);
      await release();
      expect((await paying).structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
      expect(refills).toEqual([105_000n]);
    } finally {
      await release();
    }
  });

  it('given the float lock was taken, when the next statement runs past the role limit, then it is canceled', async () => {
    const code = await withFloat(randomUUID(), 5_000, (hold) =>
      hold.tx((tx) => tx.execute(sql`select pg_sleep(1.5)`))
    ).then(
      () => 'finished',
      (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code
    );
    expect(code).toBe('57014');
  });
});

describe('the payments table', () => {
  async function settledRow() {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const result = await pay(t, { url: url('/exact') }, deps());
    return result.structuredContent!.paymentId;
  }

  it('raises when anyone moves, rewrites or deletes a settled row', async () => {
    const id = await settledRow();
    await expect(getDb().execute(sql`update payments set state = 'failed' where id = ${id}`)).rejects.toThrow();
    await expect(getDb().execute(sql`update payments set code = 'x' where id = ${id}`)).rejects.toThrow();
    await expect(getDb().execute(sql`delete from payments where id = ${id}`)).rejects.toThrow();
    expect(await rowOf(id)).toMatchObject({ state: 'settled', code: null });
  });

  it('keeps what was signed immutable and lets a live authorization fail only past its deadline', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/lost') }, deps());
    const id = lost.structuredContent!.paymentId;
    await expect(getDb().execute(sql`update payments set nonce = '0x01' where id = ${id}`)).rejects.toThrow();
    await expect(
      getDb().execute(sql`update payments set state = 'failed', finished_at = now() where id = ${id}`)
    ).rejects.toThrow();
    await expect(getDb().execute(sql`update payments set state = 'pending' where id = ${id}`)).rejects.toThrow();
    expect((await rowOf(id)).state).toBe('signed');
  });
});
