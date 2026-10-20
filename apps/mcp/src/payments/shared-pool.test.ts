import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChainClients, TopUpExecutor } from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
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
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, payments, sends } from '@/db/schema';
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
process.env.JAW_MCP_API_KEY = 'paymaster-test-key';
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
// A transfer the removed jaw_transfer left in the table: once landed, it still counts against its day.
async function landedLegacySend(t: Tenant) {
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
      periodStart: chain.start,
      fromBlock: chain.head,
      state: 'landed',
      txHash: TX(903),
      finishedAt: now,
      leaseUntil: now,
    });
}

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
  it('when jaw_session_status is read, then it counts the payment as spent and offers no transfer figure', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    await pay(t, { url: url('/a') }, deps);
    const status = await callTool(token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '600000' },
      remainingToday: { amount: '400000' },
    });
    expect(status.structuredContent.budget).not.toHaveProperty('sendableToday');
  });
});

const refused = { refusal: { code: 'budget_exhausted', next: 'jaw_grant_permissions' } };

describe('given 1 USDC a day, 2 USDC of float, and a payment of 0.6 already made', () => {
  const quote = (token: string, path: string) => callTool(token, 'jaw_session_x402_quote', { url: url(path) });

  it('when the quote asks exactly what is left, then the quote is ready and the payment settles', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    prices.set('/left', '400000');
    await pay(t, { url: url('/a') }, deps);
    const quoted = await quote(token, '/left');
    expect(quoted.structuredContent).toMatchObject({
      readiness: { status: 'ready' },
      budget: { remainingToday: { amount: '400000' } },
    });
    const paid = await pay(t, { url: url('/left') }, deps);
    expect(paid.structuredContent).toMatchObject({ state: 'settled', kind: 'paid' });
    expect(seen).toHaveLength(2);
  });

  it('when the quote asks one base unit more, then the quote says over_allowance and the payment is refused unsigned', async () => {
    const { t, token } = await connected('1', 2_000_000n);
    prices.set('/a', '600000');
    prices.set('/over', '400001');
    await pay(t, { url: url('/a') }, deps);
    const quoted = await quote(token, '/over');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'over_allowance' });
    const paid = await pay(t, { url: url('/over') }, deps);
    expect(paid.structuredContent).toMatchObject(refused);
    expect(seen).toHaveLength(1);
  });
});

describe('given 1 USDC a day, an empty float and an account that can refill it', () => {
  const quote = (token: string, path: string) => callTool(token, 'jaw_session_x402_quote', { url: url(path) });
  const refilling: TopUpExecutor = {
    request: async (method, params) => {
      if (method === 'wallet_getCallsStatus') return { status: 200 };
      const [{ calls }] = params as [{ calls: [{ data: Hex }] }];
      const [to, amount] = decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args as [Address, bigint];
      balances.set(to.toLowerCase(), balanceOf(to) + amount);
      return { id: '0xrefill' };
    },
  };
  const withRefill: PayDeps = { ...deps, executor: () => refilling };

  it('when the quote asks exactly what is left after the refill fee, then the quote is ready and the payment settles', async () => {
    const { t, token } = await connected('1', 0n);
    balances.set(t.account.toLowerCase(), 5_000_000n);
    prices.set('/left', '990000');
    const quoted = await quote(token, '/left');
    expect(quoted.structuredContent).toMatchObject({
      readiness: { status: 'ready' },
      budget: { remainingToday: { amount: '990000' } },
    });
    const paid = await pay(t, { url: url('/left') }, withRefill);
    expect(paid.structuredContent).toMatchObject({ state: 'settled', kind: 'paid' });
    expect(seen).toHaveLength(1);
  });

  it('when the quote asks one base unit more, then the quote says over_allowance and the payment is refused unsigned', async () => {
    const { t, token } = await connected('1', 0n);
    balances.set(t.account.toLowerCase(), 5_000_000n);
    prices.set('/over', '990001');
    const quoted = await quote(token, '/over');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'over_allowance' });
    const paid = await pay(t, { url: url('/over') }, withRefill);
    expect(paid.structuredContent).toMatchObject(refused);
    expect(seen).toHaveLength(0);
  });
});

describe('given 1 USDC a day and an empty float, for a price of 0.005 that a refill of 0.015 covers with its fee', () => {
  const quote = (token: string, path: string) => callTool(token, 'jaw_session_x402_quote', { url: url(path) });
  const refilling: TopUpExecutor = {
    request: async (method, params) => {
      if (method === 'wallet_getCallsStatus') return { status: 200 };
      const [{ calls }] = params as [{ calls: [{ data: Hex }] }];
      const [to, amount] = decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args as [Address, bigint];
      balances.set(to.toLowerCase(), balanceOf(to) + amount);
      return { id: '0xrefill' };
    },
  };
  const withRefill: PayDeps = { ...deps, executor: () => refilling };

  it('when the account holds exactly 0.015, then the quote is ready and the payment settles', async () => {
    const { t, token } = await connected('1', 0n);
    balances.set(t.account.toLowerCase(), 15_000n);
    prices.set('/small', '5000');
    const quoted = await quote(token, '/small');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'ready' });
    const paid = await pay(t, { url: url('/small') }, withRefill);
    expect(paid.structuredContent).toMatchObject({ state: 'settled', kind: 'paid' });
  });

  it('when the account holds one base unit less, then the quote says balance_low and the payment is refused unsigned', async () => {
    const { t, token } = await connected('1', 0n);
    balances.set(t.account.toLowerCase(), 14_999n);
    prices.set('/small', '5000');
    const quoted = await quote(token, '/small');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'balance_low' });
    expect(quoted.structuredContent.summary).toContain(t.account);
    const paid = await pay(t, { url: url('/small') }, withRefill);
    expect(paid.structuredContent).toMatchObject({ refusal: { code: 'balance_low' } });
    expect(seen).toHaveLength(0);
  });
});

describe('given 1 USDC a day, an empty float, and an upto price whose Permit2 approval is still owed', () => {
  const quote = (token: string, path: string) => callTool(token, 'jaw_session_x402_quote', { url: url(path) });
  const approvals: string[] = [];
  const approving = (owner: Address): TopUpExecutor => ({
    request: async (method, params) => {
      if (method === 'wallet_getCallsStatus') return { status: 200 };
      const [{ calls }] = params as [{ calls: [{ data: Hex }] }];
      const [to, amount] = decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args as [Address, bigint];
      balances.set(to.toLowerCase(), balanceOf(to) + amount);
      return { id: '0xrefill' };
    },
    approvePermit2: async (token) => {
      approvals.push(token);
      permitted.add(owner.toLowerCase());
      return '0xapproval';
    },
  });
  const withApproval: PayDeps = { ...deps, executor: (t) => approving(t.sessionAddress) };
  afterEach(() => void (approvals.length = 0));

  it('when the price leaves room for the 0.1 approval gas and the refill fee, then the quote is ready and pay approves and signs', async () => {
    const { t, token } = await connected('1', 0n);
    balances.set(t.account.toLowerCase(), 5_000_000n);
    prices.set('/upto-edge', '890000');
    const quoted = await quote(token, '/upto-edge');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'ready' });
    expect(quoted.structuredContent.summary).toContain('Permit2');
    const paid = await pay(t, { url: url('/upto-edge') }, withApproval);
    expect(paid.structuredContent?.refusal).toBeUndefined();
    expect(approvals).toEqual([USDC]);
    expect(seen).toHaveLength(1);
  });

  it('when the price is one base unit more, then the quote says over_allowance and pay refuses before approving or signing', async () => {
    const { t, token } = await connected('1', 0n);
    balances.set(t.account.toLowerCase(), 5_000_000n);
    prices.set('/upto-over', '890001');
    const quoted = await quote(token, '/upto-over');
    expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'over_allowance' });
    const paid = await pay(t, { url: url('/upto-over') }, withApproval);
    expect(paid.structuredContent).toMatchObject(refused);
    expect(approvals).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe('quote and pay at the edge of what a budget can pay', () => {
  const quote = (token: string, path: string) => callTool(token, 'jaw_session_x402_quote', { url: url(path) });
  // Refills the session from the account, and the permission's on-chain counter counts it.
  const counting: TopUpExecutor = {
    request: async (method, params) => {
      if (method === 'wallet_getCallsStatus') return { status: 200 };
      const [{ calls }] = params as [{ calls: [{ data: Hex }] }];
      const [to, amount] = decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args as [Address, bigint];
      balances.set(to.toLowerCase(), balanceOf(to) + amount);
      chain.spend += amount;
      return { id: '0xrefill' };
    },
  };
  const withRefill: PayDeps = { ...deps, executor: () => counting };
  const funded = async (perDay: string, float: bigint) => {
    const c = await connected(perDay, float);
    balances.set(c.t.account.toLowerCase(), 5_000_000n);
    return c;
  };

  describe('given 1 USDC a day, 0.1 paid through a refill of 0.2, so 0.1 of float is left and 0.8 can still be pulled', () => {
    const spendFirst = async (t: Tenant) => {
      prices.set('/first', '100000');
      const first = await pay(t, { url: url('/first') }, withRefill);
      expect(first.structuredContent).toMatchObject({ state: 'settled' });
    };

    it('when the quote asks the float plus all the cap less the refill fee, then it is ready and pay settles', async () => {
      const { t, token } = await funded('1', 0n);
      await spendFirst(t);
      prices.set('/rest', '890000');
      const quoted = await quote(token, '/rest');
      expect(quoted.structuredContent).toMatchObject({
        readiness: { status: 'ready' },
        budget: { remainingToday: { amount: '890000' } },
      });
      const paid = await pay(t, { url: url('/rest') }, withRefill);
      expect(paid.structuredContent).toMatchObject({ state: 'settled', kind: 'paid' });
    });

    it('when the quote asks one base unit more, then it is over_allowance and pay refuses unsigned', async () => {
      const { t, token } = await funded('1', 0n);
      await spendFirst(t);
      prices.set('/rest', '890001');
      const quoted = await quote(token, '/rest');
      expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'over_allowance' });
      const paid = await pay(t, { url: url('/rest') }, withRefill);
      expect(paid.structuredContent).toMatchObject(refused);
      expect(seen).toHaveLength(1);
    });
  });

  describe('given 5 USDC a day and 5 USDC of float, under the 1 USDC a payment that pay allows', () => {
    it('when the quote asks exactly 1 USDC, then it is ready and pay settles', async () => {
      const { t, token } = await funded('5', 5_000_000n);
      prices.set('/one', '1000000');
      const quoted = await quote(token, '/one');
      expect(quoted.structuredContent.readiness).toEqual({ status: 'ready' });
      const paid = await pay(t, { url: url('/one') }, withRefill);
      expect(paid.structuredContent).toMatchObject({ state: 'settled', kind: 'paid' });
    });

    it('when the quote asks one base unit more, then it is over_cap with its price and pay refuses over_cap unsigned', async () => {
      const { t, token } = await funded('5', 5_000_000n);
      prices.set('/more', '1000001');
      const quoted = await quote(token, '/more');
      expect(quoted.structuredContent).toMatchObject({
        kind: 'paid',
        price: { amount: '1000001' },
        readiness: { status: 'not_ready', reason: 'over_cap' },
      });
      expect(quoted.structuredContent.summary).toContain('1000000');
      const paid = await pay(t, { url: url('/more') }, withRefill);
      expect(paid.structuredContent).toMatchObject({ refusal: { code: 'over_cap' } });
      expect(seen).toHaveLength(0);
    });
  });

  describe('given 0.5 USDC a day and 0.3 of float that a payment signed under an earlier budget still holds', () => {
    const holding = async (t: Tenant) => {
      await getDb()
        .insert(payments)
        .values({
          id: `pay_${randomBytes(12).toString('base64url')}`,
          connectionId: t.connectionId,
          idempotencyKey: `held-${randomBytes(6).toString('hex')}`,
          requestHash: 'h',
          permissionId: `0x${'c'.repeat(64)}`,
          payer: t.sessionAddress.toLowerCase(),
          url: 'https://seller.example/held',
          state: 'signed',
          leaseUntil: new Date(),
          topUpAmount: '300000',
          authorized: '300000',
          nonce: `0x${randomBytes(32).toString('hex')}`,
          network: 'eip155:84532',
          scheme: 'exact',
          deadline: new Date(Date.now() + 10 * 60_000),
          authorization: {},
          signedAt: new Date(),
        });
    };

    it('when the quote asks what the cap leaves after that hold, then it is ready and pay settles', async () => {
      const { t, token } = await funded('0.5', 300_000n);
      await holding(t);
      prices.set('/after-hold', '190000');
      const quoted = await quote(token, '/after-hold');
      expect(quoted.structuredContent).toMatchObject({
        readiness: { status: 'ready' },
        budget: { remainingToday: { amount: '190000' } },
      });
      const paid = await pay(t, { url: url('/after-hold') }, withRefill);
      expect(paid.structuredContent).toMatchObject({ state: 'settled', kind: 'paid' });
    });

    it('when the quote asks one base unit more, then it is over_allowance and pay refuses unsigned', async () => {
      const { t, token } = await funded('0.5', 300_000n);
      await holding(t);
      prices.set('/after-hold', '190001');
      const quoted = await quote(token, '/after-hold');
      expect(quoted.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'over_allowance' });
      const paid = await pay(t, { url: url('/after-hold') }, withRefill);
      expect(paid.structuredContent).toMatchObject(refused);
      expect(seen).toHaveLength(0);
    });
  });
});

describe('given 1 USDC a day and a transfer of 0.5 the chain counted before the day ended', () => {
  it('when a payment of 0.6 comes in the next day, then it goes through', async () => {
    const { t } = await connected('1', 2_000_000n);
    await landedLegacySend(t);
    Object.assign(chain, { start: 86_401, spend: 0n });
    prices.set('/a', '600000');
    expect((await pay(t, { url: url('/a') }, deps)).structuredContent).toMatchObject({ kind: 'paid' });
  });
});
