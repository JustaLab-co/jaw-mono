/**
 * The daily cap across the end of a budget's day, against a local seller and a
 * real database: a payment counts in the day it was signed, whenever its row
 * was first claimed.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChainClients } from '@jaw.id/agent';
import { eq, sql } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
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
import { grants, payments } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { currentGrant } from '@/grants/store';
import { safeFetch } from '@/lib/safe-fetch';
import { requestBudget } from '@/tools/request-budget';
import { pay, type PayDeps } from './pay';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const AUTHORIZATION_USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);

interface Route {
  price: string;
  /** Held before the 402 is answered. */
  stallMs?: number;
  /** Answers the probe with a challenge nobody can pay. */
  malformed?: boolean;
}
const routes = new Map<string, Route>();
const seen: Hex[] = [];
const receipts = new Map<Hex, { from: Address; nonce: Hex }>();

const seller = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://seller').pathname;
  const route = routes.get(path);
  if (!route) return void res.writeHead(404).end();
  const signed = req.headers['payment-signature'];
  if (!signed) {
    if (route.stallMs) await new Promise((r) => setTimeout(r, route.stallMs));
    const accepts = route.malformed
      ? [{ scheme: 'exact', network: 'eip155:84532', amount: '-1', asset: USDC, payTo: PAY_TO }]
      : [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: route.price,
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
  balances.set(from.toLowerCase(), balanceOf(from) - BigInt(route.price));
  const tx = TX(receipts.size + 1);
  receipts.set(tx, { from, nonce });
  const receipt = { success: true, transaction: tx, network: 'eip155:84532', payer: from };
  res
    .writeHead(200, { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') })
    .end('{"ok":true}');
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
const used = new Set<string>();
const node = {
  getCode: async () => undefined,
  getBlockNumber: async () => 77n,
  readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
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
  getBlock: async () => ({ timestamp: 1_790_000_000n, number: 77n }),
};
const clients: ChainClients = { publicClient: () => node as unknown as PublicClient };

const deps: PayDeps = {
  clients,
  floatTarget: 0n,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  executor: () => undefined,
  fetch: safeFetch(new Set([SELLER])),
  later: () => undefined,
};

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  seen.length = 0;
  routes.clear();
});

/** A connection with one budget of `perDay` USDC and `float` already in its payer. */
async function connected(perDay: string, float: bigint) {
  const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));
  await requestBudget(t, perDay, [], {
    openWallet: fakeWallet(walletAnswers(c.signer)),
    readPermission: approvedOnChain,
    ...offlineSession,
  });
  await walletsSettled();
  if (!(await currentGrant(t.connectionId))) throw new Error('no budget');
  balances.set(t.sessionAddress.toLowerCase(), float);
  return t;
}

/** Moves the budget's anchor so its current day ends `ms` from now. */
async function dayEndsIn(t: Tenant, ms: number): Promise<number> {
  const endsAt = Date.now() + ms;
  const start = Math.floor(endsAt / 1000) - 86_400;
  await getDb()
    .update(grants)
    .set({ permission: sql`jsonb_set(${grants.permission}, '{start}', to_jsonb(${start}::bigint))` })
    .where(eq(grants.connectionId, t.connectionId));
  return Math.floor(endsAt / 1000) * 1000;
}

const url = (path: string) => `http://${SELLER}${path}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (at: number) => {
  while (Date.now() < at + 250) await sleep(50);
};
const rowOf = async (id: string) => (await getDb().select().from(payments).where(eq(payments.id, id)))[0];

describe('the daily cap at the end of a day', () => {
  it('given a seller that holds its 402 across the end of the day, when the next payment would pass the cap of the new day, then it is refused', async () => {
    const t = await connected('1', 2_000_000n);
    const boundary = await dayEndsIn(t, 3_000);
    routes.set('/stall', { price: '600000', stallMs: boundary - Date.now() + 1_500 });
    routes.set('/next', { price: '600000' });
    // Claimed before the boundary, signed after it.
    const a = await pay(t, { url: url('/stall'), idempotencyKey: 'straddle-a' }, deps);
    expect(a.structuredContent).toMatchObject({ kind: 'paid' });
    const rowA = await rowOf(a.structuredContent!.paymentId);
    expect(rowA.createdAt.getTime()).toBeLessThan(boundary);
    expect(rowA.signedAt!.getTime()).toBeGreaterThan(boundary);
    // The same new day: 0.6 already went out of it, so another 0.6 crosses the 1 USDC cap.
    const b = await pay(t, { url: url('/next'), idempotencyKey: 'straddle-b' }, deps);
    expect(b.structuredContent).toMatchObject({ refusal: { code: 'budget_exhausted' } });
    expect(seen).toHaveLength(1);
  }, 30_000);

  it('given a key refused yesterday and retried today, when the next payment would pass the cap of today, then it is refused', async () => {
    const t = await connected('1', 2_000_000n);
    const boundary = await dayEndsIn(t, 2_000);
    routes.set('/flaky', { price: '600000', malformed: true });
    routes.set('/next', { price: '600000' });
    const first = await pay(t, { url: url('/flaky'), idempotencyKey: 'stale' }, deps);
    expect(first.structuredContent).toMatchObject({ refusal: { code: 'malformed_challenge' } });
    await until(boundary);
    routes.set('/flaky', { price: '600000' });
    const retried = await pay(t, { url: url('/flaky'), idempotencyKey: 'stale' }, deps);
    expect(retried.structuredContent).toMatchObject({ kind: 'paid' });
    expect((await rowOf(retried.structuredContent!.paymentId)).createdAt.getTime()).toBeLessThan(boundary);
    const b = await pay(t, { url: url('/next'), idempotencyKey: 'stale-b' }, deps);
    expect(b.structuredContent).toMatchObject({ refusal: { code: 'budget_exhausted' } });
    expect(seen).toHaveLength(1);
  }, 30_000);
});
