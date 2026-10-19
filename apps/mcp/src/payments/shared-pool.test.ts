import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChainClients } from '@jaw.id/agent';
import { eq, sql } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  approvedOnChain,
  callTool,
  connect,
  fakeWallet,
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, sends } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { x402Budget } from '@/grants/store';
import { safeFetch } from '@/lib/safe-fetch';
import { reconcile } from '@/reconciler/run';
import { grantPermissions } from '@/tools/grant-permissions';
import { pay, type PayDeps } from './pay';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
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
const node = {
  getCode: async () => undefined,
  getBlockNumber: async () => chain.head,
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
  userOpEvents.length = 0;
  Object.assign(chain, { start: 1, end: 2_000_000_000, spend: 0n, down: false, head: 77n });
});

async function connected(perDay: string, float: bigint) {
  const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));
  await grantPermissions(
    t,
    { x402Budget: { perDay } },
    {
      openWallet: fakeWallet(walletAnswers(c.signer)),
      readPermission: approvedOnChain,
    }
  );
  await walletsSettled();
  const grant = await x402Budget(t.connectionId);
  if (!grant) throw new Error('no budget');
  chain.permissionId = grant.permissionId;
  balances.set(t.sessionAddress.toLowerCase(), float);
  return { t, token: c.access_token as string };
}

const url = (path: string) => `http://${SELLER}${path}`;
// A transfer the removed jaw_transfer left in the table: it still counts against the day until it settles.
async function legacySend(
  t: Tenant,
  row: { state?: 'open' | 'landed'; callsId?: Hex; periodStart?: number; due?: boolean } = {}
) {
  const now = new Date();
  await getDb()
    .insert(sends)
    .values({
      id: `send_${randomBytes(16).toString('base64url')}`,
      connectionId: t.connectionId,
      permissionId: chain.permissionId,
      chainId: t.chainId,
      sender: t.sessionAddress.toLowerCase(),
      amount: '500000',
      periodStart: row.periodStart ?? chain.start,
      fromBlock: chain.head,
      state: row.state ?? 'open',
      callsId: row.callsId ?? null,
      txHash: row.state === 'landed' ? TX(903) : null,
      finishedAt: row.state === 'landed' ? now : null,
      leaseUntil: new Date(now.getTime() + (row.due ? -60_000 : 60_000)),
    });
}
const refused = { refusal: { code: 'budget_exhausted', next: 'jaw_grant_permissions' } };

describe('given 1 USDC a day and a counter the chain does not answer for', () => {
  it('when a payment of 0.6 comes from the float, then it is refused as chain_unavailable and nothing is signed', async () => {
    const { t } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    chain.down = true;
    const paid = await pay(t, { url: url('/a') }, deps);
    expect(paid.structuredContent).toMatchObject({ refusal: { code: 'chain_unavailable' } });
    expect(seen).toHaveLength(0);
  });

  it('when the counter answers again, then the same payment goes through', async () => {
    const { t } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    chain.down = true;
    const down = await pay(t, { url: url('/a') }, deps);
    expect(down.structuredContent).toMatchObject({ refusal: { code: 'chain_unavailable' } });
    chain.down = false;
    const paid = await pay(t, { url: url('/a') }, deps);
    expect(paid.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
  });
});

describe('given 1 USDC a day and a payment of 0.6', () => {
  it('when jaw_status is read, then it counts the payment as spent and offers no transfer figure', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    await pay(t, { url: url('/a') }, deps);
    const status = await callTool(token, 'jaw_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '600000' },
      remainingToday: { amount: '400000' },
    });
    expect(status.structuredContent.budget).not.toHaveProperty('sendableToday');
  });
});

describe('given 1 USDC a day, 2 USDC of float, and an open transfer of 0.5 left by the removed tool', () => {
  const open = (t: Tenant) => legacySend(t, { callsId: CALLS_ID, due: true });

  it('when a payment of 0.6 comes, then it is refused and nothing is signed', async () => {
    const { t } = await connected('1', 2_000_000n);
    await open(t);
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
    expect(seen).toHaveLength(0);
  });

  it('when jaw_status is read, then it counts the transfer as spent today', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    await open(t);
    const status = await callTool(token, 'jaw_status', {});
    expect(status.structuredContent.budget).toMatchObject({ spentToday: { amount: '500000' } });
  });

  it('when the chain shows it reverted and the reconciler ran, then a payment of 0.6 goes through', async () => {
    const { t } = await connected('1', 2_000_000n);
    await open(t);
    userOpEvents.push({ userOpHash: CALLS_ID, sender: t.sessionAddress, success: false, blockNumber: 80n });
    chain.head = 81n;
    await reconcile(clients);
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });

  it('when the chain counter already counts it, then it counts once: 0.6 is refused and 0.5 goes through', async () => {
    const { t } = await connected('1', 2_000_000n);
    await open(t);
    chain.spend = 500_000n;
    prices.set('/a', '600000');
    prices.set('/b', '500000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
    expect((await pay(t, { url: url('/b') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });

  it('when it landed, the counter counts it and the reconciler ran, then 0.6 is refused and 0.5 goes through', async () => {
    const { t } = await connected('1', 2_000_000n);
    await open(t);
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
    const { t } = await connected('1', 2_000_000n);
    await legacySend(t, { state: 'landed' });
    Object.assign(chain, { start: 86_401, spend: 0n });
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });
});

describe('given 1 USDC a day and a transfer of 0.5 whose call died before the bundler', () => {
  it('when payments of 0.6 come, then they are refused until the reconciler finds nothing on chain in the window', async () => {
    const { t } = await connected('1', 2_000_000n);
    await legacySend(t, { due: true });
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
    const { t } = await connected('1', 2_000_000n);
    await legacySend(t, { due: true });
    userOpEvents.push({ userOpHash: TX(902), sender: t.sessionAddress, success: true, blockNumber: 90n });
    chain.head = 77n + 10_000n;
    await reconcile(clients);
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject(refused);
  });
});
