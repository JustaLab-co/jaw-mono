import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChainClients } from '@jaw.id/agent';
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
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  approvedOnChain,
  callTool,
  connect,
  fakeWallet,
  offlineSession,
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, payments } from '@/db/schema';
import { lockWaiters, TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { currentGrant } from '@/grants/store';
import { safeFetch } from '@/lib/safe-fetch';
import { reconcile } from '@/reconciler/run';
import { requestBudget } from '@/tools/request-budget';
import { pay, type PayDeps } from './pay';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const BOB: Address = '0x3333333333333333333333333333333333333333';
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const AUTHORIZATION_USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);

const prices = new Map<string, string>();
const seen: Hex[] = [];
const receipts = new Map<Hex, { from: Address; nonce: Hex }>();
const balances = new Map<string, bigint>();
const balanceOf = (a: string) => balances.get(a.toLowerCase()) ?? 0n;
const used = new Set<string>();

const seller = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://seller').pathname;
  const price = prices.get(path);
  if (!price) return void res.writeHead(404).end();
  const signed = req.headers['payment-signature'];
  if (!signed) {
    const accepts = [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: price,
        asset: USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2' },
      },
    ];
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${path}` }, accepts };
    return void res
      .writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') })
      .end('{}');
  }
  const proof = JSON.parse(Buffer.from(String(signed), 'base64').toString());
  const { nonce, from } = proof.payload.authorization;
  seen.push(nonce);
  used.add(nonce.toLowerCase());
  balances.set(from.toLowerCase(), balanceOf(from) - BigInt(price));
  const tx = TX(receipts.size + 1);
  receipts.set(tx, { from, nonce });
  const receipt = { success: true, transaction: tx, network: 'eip155:84532', payer: from };
  res
    .writeHead(200, { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') })
    .end('{"ok":true}');
});
await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r));
const SELLER = `127.0.0.1:${(seller.address() as AddressInfo).port}`;

const chain = { permissionId: '0x' as Hex, start: 1, end: 2_000_000_000, spend: 0n, down: false, head: 77n };
const CALLS_ID = `0x${'b'.repeat(64)}` as Hex;
const userOpEvents: { userOpHash: Hex; sender: Address; success: boolean; blockNumber: bigint }[] = [];
// PGlite reads Date.now too, so the skew lasts until the test ends to keep its clock in step.
const receiptWait = { skew: 0 };
const realNow = Date.now.bind(Date);
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + receiptWait.skew);
const gate = { hold: undefined as Promise<void> | undefined, entered: () => {} };

const node = {
  getCode: async () => undefined,
  getBlockNumber: async () => {
    if (gate.hold) {
      gate.entered();
      await gate.hold;
    }
    return chain.head;
  },
  getLogs: async ({
    args,
    fromBlock,
    toBlock,
  }: {
    args: { userOpHash?: Hex; sender?: Address };
    fromBlock: bigint;
    toBlock: bigint;
  }) =>
    userOpEvents
      .filter((op) => op.blockNumber >= fromBlock && op.blockNumber <= toBlock)
      .filter((op) => !args.userOpHash || op.userOpHash === args.userOpHash)
      .filter((op) => !args.sender || op.sender.toLowerCase() === args.sender.toLowerCase())
      .map((op) => ({ args: op, blockNumber: op.blockNumber, transactionHash: TX(900) })),
  readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    switch (functionName) {
      case 'getHash':
        return chain.permissionId;
      case 'getCurrentPeriod':
        if (chain.down) throw new Error('the node did not answer');
        return { start: chain.start, end: chain.end, spend: chain.spend };
      case 'isApproved':
        return true;
      case 'isRevoked':
        return false;
      case 'balanceOf':
        return balanceOf(args[0] as string);
      case 'allowance':
        return 0n;
      case 'authorizationState':
        return used.has(String(args[1]).toLowerCase());
    }
    throw new Error(`this node does not answer ${functionName}`);
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
  getBlock: async () => ({ timestamp: 1_790_000_000n, number: 77n }),
};
const clients: ChainClients = { publicClient: () => node as unknown as PublicClient };

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () => node as unknown as PublicClient,
}));

const bridge = {
  sent: [] as { to: Address; data: Hex }[][],
  landing: undefined as Promise<void> | undefined,
  submitted: () => {},
  answer: 'landed' as 'landed' | 'pending' | 'reverted',
  fails: undefined as Error | undefined,
};
const counted = (calls: { to: Address; data: Hex }[]) =>
  calls
    .filter((c) => c.to === USDC)
    .reduce((sum, c) => sum + (decodeFunctionData({ abi: erc20Abi, data: c.data }).args[1] as bigint), 0n);
vi.mock('@/adapters/session-host', async (original) => ({
  ...(await original<object>()),
  sessionBridge: () => ({
    request: async (method: string, params: unknown) => {
      if (method === 'wallet_sendCalls') {
        if (bridge.fails) throw bridge.fails;
        const calls = (params as [{ calls: { to: Address; data: Hex }[] }])[0].calls;
        bridge.sent.push(calls);
        bridge.submitted();
        return { id: CALLS_ID };
      }
      if (bridge.landing) await bridge.landing;
      if (bridge.answer === 'pending') {
        receiptWait.skew += 61_000;
        return { status: 100 };
      }
      if (bridge.answer === 'reverted') return { status: 500, receipts: [{ transactionHash: TX(901) }] };
      chain.spend += counted(bridge.sent[bridge.sent.length - 1]);
      return { status: 200, receipts: [{ transactionHash: `0x${'c'.repeat(64)}` }] };
    },
  }),
}));

setTestEnv();
process.env.JAW_MCP_INSECURE_FETCH_HOSTS = SELLER;
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';

const deps: PayDeps = {
  clients,
  floatTarget: 0n,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  executor: () => undefined,
  fetch: safeFetch(new Set([SELLER])),
  later: () => undefined,
};

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterEach(() => {
  seen.length = 0;
  prices.clear();
  bridge.sent.length = 0;
  bridge.landing = undefined;
  bridge.submitted = () => {};
  bridge.answer = 'landed';
  bridge.fails = undefined;
  gate.hold = undefined;
  userOpEvents.length = 0;
  receiptWait.skew = 0;
  Object.assign(chain, { start: 1, end: 2_000_000_000, spend: 0n, down: false, head: 77n });
});

async function connected(perDay: string, float: bigint) {
  const c = await connect(undefined, { scope: 'wallet:read wallet:send x402:pay' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));
  await requestBudget(t, perDay, {
    openWallet: fakeWallet(walletAnswers(c.signer)),
    readPermission: approvedOnChain,
    ...offlineSession,
  });
  await walletsSettled();
  const grant = await currentGrant(t.connectionId);
  if (!grant) throw new Error('no budget');
  chain.permissionId = grant.permissionId;
  balances.set(t.sessionAddress.toLowerCase(), float);
  return { t, token: c.access_token as string };
}

const url = (path: string) => `http://${SELLER}${path}`;
const transfer = (token: string, amount: string) => callTool(token, 'jaw_transfer', { to: BOB, amount });
const unconfirmed = async (token: string, amount: string) => {
  bridge.answer = 'pending';
  const sent = await transfer(token, amount);
  expect(sent.structuredContent).toMatchObject({ status: 'unconfirmed' });
  bridge.answer = 'landed';
};
const refused = { refusal: { code: 'budget_exhausted', next: 'jaw_request_budget' } };
const rowOf = async (id: string) => (await getDb().select().from(payments).where(eq(payments.id, id)))[0];

describe('given 1 USDC a day and 2 USDC of float pulled on an earlier day', () => {
  it('when a transfer of 0.5 ran and a payment of 0.6 comes from the float, then the payment is refused', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    const sent = await transfer(token, '0.5');
    expect(sent.structuredContent).toMatchObject({ status: 'landed' });
    prices.set('/a', '600000');
    const paid = await pay(t, { url: url('/a') }, deps);
    expect(paid.structuredContent).toMatchObject({
      refusal: { code: 'budget_exhausted', next: 'jaw_request_budget' },
    });
    expect(seen).toHaveLength(0);
  });

  it('when payments of 0.6 ran from the float and a transfer of 0.5 comes, then the transfer is refused', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
    const sent = await transfer(token, '0.5');
    expect(sent.isError).toBe(true);
    expect(sent.content[0].text).toContain('jaw_request_budget');
    expect(sent.content[0].text).toContain('Nothing was sent');
    expect(bridge.sent).toEqual([]);
  });

  it('when a transfer of 0.3 and a payment of 0.6 run, then both go through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    expect((await transfer(token, '0.3')).structuredContent).toMatchObject({ status: 'landed' });
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
    expect(bridge.sent).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('when 0.6 was paid, then a transfer of what jaw_status says is left goes through and one unit more does not', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    await pay(t, { url: url('/a') }, deps);
    const status = await callTool(token, 'jaw_status', {});
    expect(status.structuredContent.budget).toMatchObject({ spentToday: { amount: '600000' } });
    const left = status.structuredContent.budget.sendableToday.amount;
    expect(left).toBe('400000');
    expect((await transfer(token, '0.400001')).isError).toBe(true);
    expect((await transfer(token, '0.4')).structuredContent).toMatchObject({ status: 'landed' });
  });
});

describe('given 1 USDC a day and a counter the chain does not answer for', () => {
  it('when a transfer comes, then it is refused and nothing is sent', async () => {
    const { token } = await connected('1', 0n);
    chain.down = true;
    const sent = await transfer(token, '0.1');
    expect(sent.isError).toBe(true);
    expect(sent.content[0].text).toContain('could not be read from the chain');
    expect(bridge.sent).toEqual([]);
  });
});

describe('given 1 USDC a day at the end of a day', () => {
  it('when 0.6 was paid before the day ended, then a transfer of 0.5 after it goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    const paid = await pay(t, { url: url('/a') }, deps);
    const signedAt = (await rowOf(paid.structuredContent!.paymentId)).signedAt!.getTime();
    Object.assign(chain, { start: Math.floor(signedAt / 1000) + 1 });
    expect((await transfer(token, '0.5')).structuredContent).toMatchObject({ status: 'landed' });
  });

  it('when 0.6 was paid after the day started, then a transfer of 0.5 is refused', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    const paid = await pay(t, { url: url('/a') }, deps);
    const signedAt = (await rowOf(paid.structuredContent!.paymentId)).signedAt!.getTime();
    Object.assign(chain, { start: Math.floor(signedAt / 1000) - 1 });
    expect((await transfer(token, '0.5')).isError).toBe(true);
    expect(bridge.sent).toEqual([]);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given 1 USDC a day and a payment and a transfer at once', () => {
  it('when the payment holds its turn first, then exactly one of them goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (gate.entered = r));
    const paying = pay(t, { url: url('/a') }, deps);
    await entered;
    gate.hold = undefined;
    const sending = transfer(token, '0.5');
    for (let i = 0; i < 100 && (await lockWaiters(t.connectionId)) === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    release();
    const [paid, sent] = await Promise.all([paying, sending]);
    const wins = [paid.structuredContent?.kind === 'paid', sent.structuredContent?.status === 'landed'];
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(seen.length + bridge.sent.length).toBe(1);
  }, 30_000);

  it('when the transfer holds its turn first, then exactly one of them goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    let land!: () => void;
    bridge.landing = new Promise<void>((r) => (land = r));
    const submitted = new Promise<void>((r) => (bridge.submitted = r));
    const sending = transfer(token, '0.5');
    await submitted;
    const paying = pay(t, { url: url('/a') }, deps);
    for (let i = 0; i < 100 && (await lockWaiters(t.connectionId)) === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    land();
    const [paid, sent] = await Promise.all([paying, sending]);
    const wins = [paid.structuredContent?.kind === 'paid', sent.structuredContent?.status === 'landed'];
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(seen.length + bridge.sent.length).toBe(1);
  }, 30_000);
});

describe('given 1 USDC a day, 2 USDC of float, and a transfer of 0.5 the bundler took and did not confirm in time', () => {
  it('when a payment of 0.6 comes, then it is refused and nothing is signed', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    await unconfirmed(token, '0.5');
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
    expect(seen).toHaveLength(0);
  });

  it('when a transfer of 0.6 comes, then it is refused and nothing more is sent', async () => {
    const { token } = await connected('1', 2_000_000n);
    await unconfirmed(token, '0.5');
    const sent = await transfer(token, '0.6');
    expect(sent.content[0].text).toContain('Nothing was sent');
    expect(bridge.sent).toHaveLength(1);
  });

  it('when jaw_status is read, then it counts the transfer as spent today', async () => {
    const { token } = await connected('1', 2_000_000n);
    await unconfirmed(token, '0.5');
    const status = await callTool(token, 'jaw_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '500000' },
      sendableToday: { amount: '500000' },
    });
  });

  it('when the chain shows it reverted and the reconciler ran, then a payment of 0.6 goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    await unconfirmed(token, '0.5');
    userOpEvents.push({ userOpHash: CALLS_ID, sender: t.sessionAddress, success: false, blockNumber: 80n });
    chain.head = 81n;
    await reconcile(clients);
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });

  it('when the chain counter already counts it, then it counts once: 0.6 is refused and 0.5 goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    await unconfirmed(token, '0.5');
    chain.spend = 500_000n;
    prices.set('/a', '600000');
    prices.set('/b', '500000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
    expect((await pay(t, { url: url('/b') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });

  it('when it landed, the counter counts it and the reconciler ran, then 0.6 is refused and 0.5 goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    await unconfirmed(token, '0.5');
    userOpEvents.push({ userOpHash: CALLS_ID, sender: t.sessionAddress, success: true, blockNumber: 80n });
    chain.spend = 500_000n;
    chain.head = 81n;
    await reconcile(clients);
    prices.set('/a', '600000');
    prices.set('/b', '500000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
    expect((await pay(t, { url: url('/b') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });
});

describe('given 1 USDC a day and a transfer of 0.5 the chain counted before the day ended', () => {
  it('when a payment of 0.6 comes in the next day, then it goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    expect((await transfer(token, '0.5')).structuredContent).toMatchObject({ status: 'landed' });
    Object.assign(chain, { start: 86_401, spend: 0n });
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });
});

describe('given 1 USDC a day and a transfer of 0.5 the simulation refused before the bundler', () => {
  it('when a payment of 0.6 comes, then it goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    bridge.fails = new Error('Could not size the ERC-20 paymaster approval: execution reverted');
    expect((await transfer(token, '0.5')).content[0].text).toContain('Nothing was sent');
    bridge.fails = undefined;
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });
});

describe('given 1 USDC a day and a transfer of 0.5 whose receipt says it reverted', () => {
  it('when a payment of 0.6 comes, then it goes through', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    bridge.answer = 'reverted';
    expect((await transfer(token, '0.5')).structuredContent).toMatchObject({ status: 'reverted' });
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });
});

describe('given 1 USDC a day and a transfer of 0.5 whose call died after its row was written, before the bundler', () => {
  it('when payments of 0.6 come, then they are refused until the reconciler finds nothing on chain in the window', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    bridge.fails = new Error('the bundler was never reached');
    expect((await transfer(token, '0.5')).isError).toBe(true);
    expect(bridge.sent).toEqual([]);
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
    const lapse = () => getDb().execute(sql`update sends set lease_until = now() - interval '1 minute'`);
    await lapse();
    await reconcile(clients);
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
    await lapse();
    chain.head = 77n + 10_000n;
    await reconcile(clients);
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });

  it('when another send of the session landed in the window, then the row stays counted', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    bridge.fails = new Error('the bundler was never reached');
    await transfer(token, '0.5');
    userOpEvents.push({ userOpHash: TX(902), sender: t.sessionAddress, success: true, blockNumber: 90n });
    await getDb().execute(sql`update sends set lease_until = now() - interval '1 minute'`);
    chain.head = 77n + 10_000n;
    await reconcile(clients);
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
  });
});

describe('given 1 USDC a day and a transfer whose row cannot be written', () => {
  it('when the transfer comes, then nothing is sent', async () => {
    const { token } = await connected('1', 2_000_000n);
    await getDb().execute(sql`alter table sends add constraint no_new_sends check (false) not valid`);
    try {
      const sent = await transfer(token, '0.5');
      expect(sent.isError).toBe(true);
      expect(sent.content[0].text).toContain('Nothing was sent');
    } finally {
      await getDb().execute(sql`alter table sends drop constraint no_new_sends`);
    }
    expect(bridge.sent).toEqual([]);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given 1 USDC a day and a transfer that ends unconfirmed', () => {
  it('when a payment waits for the transfer to finish its turn, then the payment is refused and only the transfer went out', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    bridge.answer = 'pending';
    let land!: () => void;
    bridge.landing = new Promise<void>((r) => (land = r));
    const submitted = new Promise<void>((r) => (bridge.submitted = r));
    const sending = transfer(token, '0.5');
    await submitted;
    const paying = pay(t, { url: url('/a') }, deps);
    for (let i = 0; i < 100 && (await lockWaiters(t.connectionId)) === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    land();
    const [paid, sent] = await Promise.all([paying, sending]);
    expect(sent.structuredContent).toMatchObject({ status: 'unconfirmed' });
    expect(paid.structuredContent).toMatchObject(refused);
    expect(seen).toHaveLength(0);
    expect(bridge.sent).toHaveLength(1);
  }, 30_000);
});
