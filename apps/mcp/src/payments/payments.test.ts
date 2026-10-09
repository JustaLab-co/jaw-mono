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
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decideFromPage, readForPage } from '@/approvals/page-api';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { endConnection } from '@/connections/rows';
import { callTool, connect, setTestEnv, verifyLocally } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { payments, settings } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { safeFetch } from '@/lib/safe-fetch';
import { pay, type PayDeps } from './pay';
import { lockFloat, stillHeld } from './refill';
import { claim, holdingRows } from './store';

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
};
const seen: { path: string; nonce: Hex; signature: Hex; advisoryLocks: number }[] = [];
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
          scheme: 'exact',
          network: 'eip155:84532',
          amount: PRICES[path],
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' },
        },
      ],
    };
    return void res
      .writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') })
      .end('{}');
  }
  const proof = JSON.parse(Buffer.from(String(signed), 'base64').toString());
  const { nonce, from } = proof.payload.authorization;
  await onProof.get(path)?.();
  const [{ n }] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`pg_locks`)
    .where(sql`locktype = 'advisory'`);
  seen.push({ path, nonce, signature: proof.payload.signature, advisoryLocks: n });
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
  const tx = path === '/sametx' ? TX(999) : TX(seen.length);
  receipts.set(tx, { from, nonce });
  const receipt = { success: true, transaction: tx, network: 'eip155:84532', payer: from };
  res
    .writeHead(200, { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') })
    .end(JSON.stringify({ report: 'the weather is fine' }));
});
await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r));
const SELLER = `127.0.0.1:${(seller.address() as AddressInfo).port}`;

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

beforeAll(useTestDb);
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
    expect(again.structuredContent).toMatchObject({ refusal: { code: 'settlement_rejected' } });
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
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ state: 'failed', nonce: null });
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

  it('refills to the float target, so the next payments need no refill', async () => {
    const { t } = await connected('1');
    await pay(t, { url: url('/exact'), idempotencyKey: 'float-1' }, deps({ floatTarget: 50_000n }));
    await pay(t, { url: url('/exact'), idempotencyKey: 'float-2' }, deps({ floatTarget: 50_000n }));
    expect(refills).toEqual([150_000n]);
  });

  it('gives five concurrent payments their own rows and one refill, with no lock held across a fetch', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 5_000n);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => pay(t, { url: url('/slow'), idempotencyKey: `burst-${n}` }, deps()))
    );
    expect(new Set(results.map((r) => r.structuredContent?.paymentId)).size).toBe(5);
    expect(results.every((r) => r.structuredContent?.kind === 'paid')).toBe(true);
    expect(refills).toEqual([105_000n]);
    expect(seen.map((s) => s.advisoryLocks)).toEqual([0, 0, 0, 0, 0]);
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
    getDb().transaction(async (tx) => {
      await lockFloat(tx, t.connectionId, 1_000);
      if (held) held.push(await stillHeld(await holdingRows(tx, t.sessionAddress, randomUUID()), clients, 77n));
      await endConnection(t.connectionId, t.account, new Date(), tx);
    });

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
