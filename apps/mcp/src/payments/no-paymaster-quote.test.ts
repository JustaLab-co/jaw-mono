import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChainClients } from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
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
  offlineSession,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { x402Budget } from '@/grants/store';
import { safeFetch } from '@/lib/safe-fetch';
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
const permitted = new Set<string>();

const seller = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://seller').pathname;
  const price = prices.get(path);
  if (!price) return void res.writeHead(404).end();
  const signed = req.headers['payment-signature'];
  if (!signed) {
    const accepts = [
      {
        scheme: path.startsWith('/upto') ? 'upto' : 'exact',
        network: 'eip155:84532',
        amount: price,
        asset: USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2', facilitatorAddress: PAY_TO },
      },
    ];
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${path}` }, accepts };
    return void res
      .writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') })
      .end('{}');
  }
  const proof = JSON.parse(Buffer.from(String(signed), 'base64').toString());
  const { nonce, from } = proof.payload.authorization ?? proof.payload.permit2Authorization;
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
        return permitted.has(String(args[0]).toLowerCase()) ? 2n ** 160n : 0n;
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
      session: offlineSession,
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

const quote = (token: string, path: string) => callTool(token, 'jaw_session_x402_quote', { url: url(path) });

// This server has no JAW_MCP_API_KEY, so it can neither refill the session nor approve Permit2.
describe('given a server without a paymaster key, 1 USDC a day and 0.3 of float', () => {
  it('when the quote asks exactly the float, then it is ready and pay settles from it', async () => {
    const { t, token } = await connected('1', 300_000n);
    prices.set('/float', '300000');
    const quoted = await quote(token, '/float');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'ready' });
    const paid = await pay(t, { url: url('/float') }, deps);
    expect(paid.structuredContent).toMatchObject({ state: 'settled', kind: 'paid' });
  });

  it('when the quote asks one base unit more, then it is funding_unavailable and pay cannot fund it', async () => {
    const { t, token } = await connected('1', 300_000n);
    balances.set(t.account.toLowerCase(), 5_000_000n);
    prices.set('/more', '300001');
    const quoted = await quote(token, '/more');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'funding_unavailable' });
    const paid = await pay(t, { url: url('/more') }, deps);
    expect(paid.structuredContent).toMatchObject({ refusal: { code: 'funding_failed' } });
    expect(seen).toHaveLength(0);
  });
});

describe('given a server without a paymaster key and an upto price whose Permit2 approval is still owed', () => {
  it('when the float covers the price and the approval gas, then the quote is funding_unavailable and pay signs nothing', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/upto-owed', '5000');
    const quoted = await quote(token, '/upto-owed');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'funding_unavailable' });
    const paid = await pay(t, { url: url('/upto-owed') }, deps);
    expect(paid.structuredContent?.refusal).toBeDefined();
    expect(seen).toHaveLength(0);
  });
});
