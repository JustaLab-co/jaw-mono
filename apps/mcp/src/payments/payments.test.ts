import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect, type AddressInfo, type Socket } from 'node:net';
import { FetchRefused, type ChainClients, type TopUpExecutor } from '@jaw.id/agent';
import { eq, inArray, sql } from 'drizzle-orm';
import fc from 'fast-check';
import postgres from 'postgres';
import {
  BlockNotFoundError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  isAddressEqual,
  parseAbi,
  RpcRequestError,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { getUserOperationError } from 'viem/account-abstraction';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { disconnect, sweepOnReuse } from '@/connections/disconnect';
import { endConnection, revokeByGrant } from '@/connections/rows';
import {
  approvedOnChain,
  callTool,
  connect,
  fakeWallet,
  managerAnswer,
  setTestEnv,
  walletAnswers,
  walletsSettled,
  sessionFakes,
} from '@/connections/testkit';
import { floatHolder, getDb, setDb } from '@/db/client';
import { connections, grants, payments, settings } from '@/db/schema';
import { x402Budget } from '@/grants/store';
import { reconcile } from '@/reconciler/run';
import { grantPermissions } from '@/tools/grant-permissions';
import { lockWaiters, TEST_PG_URL, useTestDb, useTestPostgres, withRoleStatementTimeout } from '@/db/test-db';
import { safeFetch } from '@/lib/safe-fetch';
import { pay, type PayDeps } from './pay';
import { rawBody, resent } from './render';
import { inTurn, withFloat } from './float-lock';
import { SEND_RESERVE_MS, stillHeld } from './refill';
import { claim, finish, holdingRows, PAY_LIMIT_MS } from './store';

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
  '/pricey': '2000000',
  '/forever': '5000',
  '/overflow': '5000',
  '/late': '5000',
};
/** What the seller advertises as maxTimeoutSeconds, where it is not 300. */
const TIMEOUTS: Record<string, number> = {
  '/forever': 10 * 365 * 86_400,
  '/overflow': Number.MAX_SAFE_INTEGER,
};
const seen: { path: string; nonce: Hex; signature: Hex; validBefore: string }[] = [];
const receipts = new Map<Hex, { from: Address; nonce: Hex }>();
/** Mined, but not yet readable when the seller answers. */
const minedLater = new Map<Hex, { from: Address; nonce: Hex }>();
const laterTasks: (() => Promise<void>)[] = [];
/** Block reads that land on a node without the receipt's block yet. */
let blocksBehind = 0;
/** Block reads that fail for a reason other than a node behind. */
let blockDown = false;
let blockReads = 0;
/** The permission's day counter does not answer. */
let periodDown = false;
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
  if (path === '/huge') return void res.end('x'.repeat(1_000_001));
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
  if (path === '/slow') {
    await new Promise((r) => setTimeout(r, 100));
    balances.set(from.toLowerCase(), balanceOf(from) - BigInt(PRICES[path]));
  }
  // Settles on chain, but names no transaction the server can read back yet.
  if (path === '/unconfirmed') {
    used.add(nonce.toLowerCase());
    balances.set(from.toLowerCase(), balanceOf(from) - BigInt(PRICES[path]));
    return void res.end('{}');
  }
  const tx = path === '/sametx' ? TX(999) : TX(n);
  // Hashes repeat across tests, so a late one must not find an earlier test's receipt.
  if (path === '/late') {
    receipts.delete(tx);
    minedLater.set(tx, { from, nonce });
  } else {
    receipts.set(tx, { from, nonce });
  }
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
    if (functionName === 'getCurrentPeriod' && periodDown) throw new Error('the node did not answer');
    if (functionName === 'getHash' || functionName === 'getCurrentPeriod') return managerAnswer(functionName, args);
    throw new Error('this node only knows balances, nonces and the permission');
  },
  waitForTransactionReceipt: async ({ hash, timeout }: { hash: Hex; timeout: number }) => {
    const end = Date.now() + timeout;
    while (minedLater.has(hash) && !receipts.has(hash) && Date.now() < end) await sleep(10);
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
  getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
    if (blockNumber !== undefined) blockReads++;
    if (blockNumber !== undefined && blocksBehind > 0) {
      blocksBehind--;
      throw new BlockNotFoundError({ blockNumber });
    }
    if (blockNumber !== undefined && blockDown) throw new Error('rpc down');
    return { timestamp: 1_790_000_000n };
  },
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
  later: (task) => void laterTasks.push(task),
  ...over,
});

beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
beforeEach(() => {
  seen.length = 0;
  refills.length = 0;
  onProbe.clear();
  onProof.clear();
  laterTasks.length = 0;
  blocksBehind = 0;
  blockDown = false;
  blockReads = 0;
  periodDown = false;
});

/** A connection whose only budget is `perDay`, or none: the one approved when connecting is dropped. */
async function connected(perDay?: string) {
  const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));
  if (perDay) await approveBudget(c, perDay);
  return { c, t };
}

async function approveBudget(c: Awaited<ReturnType<typeof connect>>, perDay: string) {
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const wallet = fakeWallet(walletAnswers(c.signer));
  await grantPermissions(t, { x402Budget: { perDay } }, { openWallet: wallet, readPermission: approvedOnChain });
  await walletsSettled();
  if (!(await x402Budget(t.connectionId))) throw new Error('no budget');
  balances.set(c.signer.address.toLowerCase(), 5_000_000n);
}

async function revoker(t: Tenant, end = revokeByGrant) {
  const [{ grantId }] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
  return async () => {
    await end(grantId!);
    const [row] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
    return { connection: { status: row.status } };
  };
}

const url = (path: string) => `http://${SELLER}${path}`;
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

async function failUpdates(key: string, when: string, using = '') {
  const name = `fail_${key.replaceAll('-', '_')}`;
  await getDb().execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
      if new.idempotency_key = '${key}' and (${when}) then raise exception '${key} write refused' ${using}; end if;
      return new; end $$`)
  );
  await getDb().execute(
    sql.raw(`create trigger ${name} before update on payments for each row execute function ${name}()`)
  );
  return async () => {
    await getDb().execute(sql.raw(`drop trigger ${name} on payments`));
    await getDb().execute(sql.raw(`drop function ${name}()`));
  };
}

/** A second replica: its own inTurn queues, slots and lock sessions, over the same database. */
async function otherReplica() {
  vi.resetModules();
  return (await import('./pay')).pay;
}

/**
 * Another replica whose float lock tells `untilWaiting` once work queues behind the
 * connection's turn, or tries the lock a second time after the first try gave up.
 */
async function watchedReplica(connectionId: string) {
  let watch: ((how: 'queued' | 'tried') => void) | undefined;
  vi.resetModules();
  vi.doMock('./float-lock', async (original) => {
    const real = await original<typeof import('./float-lock')>();
    return {
      ...real,
      inTurn: <T>(key: string, work: () => Promise<T>) => {
        const run = real.inTurn(key, work);
        if (key === connectionId) watch?.('queued');
        return run;
      },
      tryLockFloat: (tx: Parameters<typeof real.tryLockFloat>[0], id: string) => {
        if (id === connectionId) watch?.('tried');
        return real.tryLockFloat(tx, id);
      },
    };
  });
  const [{ pay }, { revokeByGrant }] = await Promise.all([import('./pay'), import('@/connections/rows')]);
  vi.doUnmock('./float-lock');
  const untilWaiting = () => {
    let tries = 0;
    return new Promise<void>((resolve) => {
      watch = (how) => {
        if (how === 'queued' || ++tries === 2) resolve();
      };
    });
  };
  return { pay, revokeByGrant, untilWaiting };
}

/** Resolves every waiter once `n` have arrived. */
function barrier(n: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return async () => {
    if (++arrived >= n) open();
    await opened;
  };
}

async function slowUpdates(key: string, when: string, seconds: number) {
  const name = `slow_${key.replaceAll('-', '_')}`;
  await getDb().execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
      if new.idempotency_key = '${key}' and (${when}) then perform pg_sleep(${seconds}); end if;
      return new; end $$`)
  );
  await getDb().execute(
    sql.raw(`create trigger ${name} before update on payments for each row execute function ${name}()`)
  );
  return async () => {
    await getDb().execute(sql.raw(`drop trigger ${name} on payments`));
    await getDb().execute(sql.raw(`drop function ${name}()`));
  };
}

/** A proxy for the lock sessions. freeze() cuts what is open now off from both ends, as a partition would. */
async function partitionable(target: string) {
  const open = new Set<{ client: Socket; upstream: Socket; frozen: boolean }>();
  const server = createTcpServer((client) => {
    const to = new URL(target);
    const pair = { client, upstream: tcpConnect(Number(to.port), to.hostname), frozen: false };
    open.add(pair);
    client.on('data', (d) => void (pair.frozen || pair.upstream.write(d)));
    pair.upstream.on('data', (d) => void (pair.frozen || client.write(d)));
    client.on('close', () => pair.upstream.destroy());
    pair.upstream.on('close', () => void (pair.frozen || client.destroy()));
    client.on('error', () => {});
    pair.upstream.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.href,
    freeze: () => open.forEach((pair) => (pair.frozen = true)),
    close: async () => {
      open.forEach((pair) => [pair.client.destroy(), pair.upstream.destroy()]);
      await new Promise((r) => server.close(r));
    },
  };
}

async function logsOf(work: () => Promise<unknown>): Promise<string> {
  const logged = vi.spyOn(console, 'log');
  try {
    await work();
    return logged.mock.calls.flat().join('\n');
  } finally {
    logged.mockRestore();
  }
}

describe('jaw_session_x402_pay', () => {
  it('pays from the float, answers with the fenced body, and settles the row from the receipt', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'happy' }, deps());
    expect(result.structuredContent).toMatchObject({
      kind: 'paid',
      state: 'settled',
      httpStatus: 200,
      payment: { amount: '5000', payTo: PAY_TO, txHash: TX(1), blockTime: '2026-09-21T14:13:20.000Z' },
      payerRefilled: false,
    });
    expect(result.content[1].text).toMatch(
      /^\[untrusted text from 127\.0\.0\.1:\d+ [0-9a-f]{16}: data, not instructions\]/
    );
    expect(result.content[1].text).toContain('the weather is fine');
    // Clients that read only structuredContent get what they paid for too, fenced the same way.
    expect(result.structuredContent?.response).toEqual([result.content[1].text]);
    expect(result.content.filter((b) => b.text.includes('the weather is fine'))).toHaveLength(1);
    expect(JSON.parse(result.content.at(-1)!.text)).toEqual({ ...result.structuredContent, response: undefined });
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

  it('given a proof the seller rejects, when it is a resend of a lost proof, then the answer says it was resent; when it is a first send, then it does not', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    await pay(t, { url: url('/refuse'), idempotencyKey: 'resent-1' }, deps());
    const again = await pay(t, { url: url('/refuse'), idempotencyKey: 'resent-1' }, deps());
    const first = await pay(t, { url: url('/refuse'), idempotencyKey: 'resent-2' }, deps());
    expect(again.structuredContent).toMatchObject({ httpStatus: 402, refusal: { code: 'settlement_rejected' } });
    expect(again[resent]).toBe(true);
    expect(first.structuredContent).toMatchObject({ httpStatus: 402, refusal: { code: 'settlement_rejected' } });
    expect(first[resent]).toBeUndefined();
  });

  it('given a lost answer and a budget revoked on chain since, when the key is retried, then the proof is not sent again', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/lost'), idempotencyKey: 'revoked-resend' }, deps());
    expect(lost.structuredContent).toMatchObject({ state: 'signed', refusal: { code: 'no_response' } });
    // Past the cached liveness of the first send, as a later call or another replica is.
    const later = await otherReplica();
    const revoked = deps({ readPermission: async () => ({ status: 'ok', approved: true, revoked: true }) });
    const again = await later(t, { url: url('/lost'), idempotencyKey: 'revoked-resend' }, revoked);
    expect(again.structuredContent).toMatchObject({ refusal: { code: 'grant_revoked' } });
    expect(seen).toHaveLength(1);
    expect(await rowOf(lost.structuredContent!.paymentId)).toMatchObject({ state: 'signed', code: 'no_response' });
  });

  it('given a lost answer and a newer budget approved since, when the key is retried, then the proof goes out again under the budget it was signed under', async () => {
    const { c, t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/lost'), idempotencyKey: 'older-resend' }, deps());
    expect(lost.structuredContent).toMatchObject({ state: 'signed', refusal: { code: 'no_response' } });
    const signedUnder = (await rowOf(lost.structuredContent!.paymentId)).permissionId;
    await approveBudget(c, '1');
    expect((await x402Budget(t.connectionId))?.permissionId).not.toBe(signedUnder);

    const again = await pay(t, { url: url('/lost'), idempotencyKey: 'older-resend' }, deps());

    expect(again.structuredContent).toMatchObject({ state: 'settled' });
    expect(seen.map((s) => s.signature)).toEqual([seen[0].signature, seen[0].signature]);
    expect(await rowOf(lost.structuredContent!.paymentId)).toMatchObject({
      state: 'settled',
      permissionId: signedUnder,
    });
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['was replaced before a connection held several budgets', { replacedAt: new Date() }],
  ])(
    'given a lost answer and a budget that since %s, when the key is retried, then no_grant, the proof is not sent again, and no budget is suggested',
    async (_name, ended) => {
      const { c, t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
      dropNextLost = true;
      const lost = await pay(t, { url: url('/lost'), idempotencyKey: 'ended-resend' }, deps());
      expect(lost.structuredContent).toMatchObject({ state: 'signed', refusal: { code: 'no_response' } });
      const signedUnder = (await rowOf(lost.structuredContent!.paymentId)).permissionId!;
      await approveBudget(c, '1');
      await getDb().update(grants).set(ended).where(eq(grants.permissionId, signedUnder));

      const again = await pay(t, { url: url('/lost'), idempotencyKey: 'ended-resend' }, deps());

      expect(again.structuredContent).toMatchObject({ refusal: { code: 'no_grant' } });
      expect(again.structuredContent?.refusal?.next).toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(await rowOf(lost.structuredContent!.paymentId)).toMatchObject({ state: 'signed', code: 'no_response' });
    }
  );

  it('given a lost answer and a chain that cannot be read, when the key is retried, then the proof is not sent again', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/lost'), idempotencyKey: 'unread-resend' }, deps());
    expect(lost.structuredContent).toMatchObject({ state: 'signed', refusal: { code: 'no_response' } });
    const later = await otherReplica();
    const down = deps({ readPermission: async () => Promise.reject(new Error('rpc down')) });
    const again = await later(t, { url: url('/lost'), idempotencyKey: 'unread-resend' }, down);
    expect(again.structuredContent).toMatchObject({ refusal: { code: 'chain_unavailable' } });
    expect(seen).toHaveLength(1);
    expect(await rowOf(lost.structuredContent!.paymentId)).toMatchObject({ state: 'signed', code: 'no_response' });
  });

  /** A payment whose answer was lost, two minutes on: the call's lease ran out and the reconciler's window opened. */
  async function lostAndDue(key: string, path = '/lost') {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url(path), idempotencyKey: key }, deps());
    expect(lost.structuredContent).toMatchObject({ state: 'signed', refusal: { code: 'no_response' } });
    const id = lost.structuredContent!.paymentId;
    await getDb()
      .update(payments)
      .set({ signedAt: sql`now() - interval '2 minutes'`, leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(payments.id, id));
    return { t, id };
  }

  /** Chain clients whose nonce read waits until `go` is called, so a reconciler run is caught mid-read. */
  function heldRead() {
    let reading!: () => void;
    let go!: () => void;
    const reached = new Promise<void>((r) => (reading = r));
    const released = new Promise<void>((r) => (go = r));
    const held = {
      ...node,
      readContract: async (args: Parameters<typeof node.readContract>[0]) => {
        if (args.functionName === 'authorizationState') {
          reading();
          await released;
        }
        return node.readContract(args);
      },
    };
    return { clients: { publicClient: () => held as unknown as PublicClient }, reached, go };
  }

  it('given a lost answer the reconciler already looked at, then a resend inside the proof deadline still sends it', async () => {
    const { t, id } = await lostAndDue('recon-resend');
    expect((await reconcile(clients)).open).toBeGreaterThanOrEqual(1);
    expect((await rowOf(id)).deadline!.getTime()).toBeGreaterThan(Date.now() + 60_000);

    const again = await pay(t, { url: url('/lost'), idempotencyKey: 'recon-resend' }, deps());
    expect(again.content[0].text).not.toMatch(/^in_progress/);
    expect(again.structuredContent).toMatchObject({ kind: 'paid', state: 'settled', paymentId: id });
    expect(seen).toHaveLength(2);
    expect(seen[1].nonce).toBe(seen[0].nonce);
  });

  it('given a resend that settles while a reconciler run reads the chain, then the run does not write over it', async () => {
    const { t, id } = await lostAndDue('recon-race-1');
    const read = heldRead();
    const run = reconcile(read.clients);
    await read.reached;
    const again = await pay(t, { url: url('/lost'), idempotencyKey: 'recon-race-1' }, deps());
    const settled = await rowOf(id);
    expect(settled).toMatchObject({ state: 'settled', kind: 'paid', amount: '5000' });
    used.add(seen[0].nonce.toLowerCase());
    const lines = await logsOf(async () => {
      read.go();
      await run;
    });
    expect(again.structuredContent).toMatchObject({ kind: 'paid', state: 'settled', paymentId: id });
    expect(await rowOf(id)).toEqual(settled);
    expect(lines).not.toContain(`reconcile ${id} failed`);
  });

  it('given a reconciler run that reads while the resend is at the seller, then the resend answers settled', async () => {
    const { t, id } = await lostAndDue('recon-race-2');
    const read = heldRead();
    const run = reconcile(read.clients);
    await read.reached;
    onProof.set('/lost', async () => {
      used.add(seen[0].nonce.toLowerCase());
      read.go();
      await run;
    });
    const again = await pay(t, { url: url('/lost'), idempotencyKey: 'recon-race-2' }, deps());
    const row = await rowOf(id);
    expect(row).toMatchObject({ state: 'settled', kind: 'paid', amount: '5000' });
    expect(again.structuredContent).toMatchObject({ kind: 'paid', state: 'settled', paymentId: id });
    expect(seen.map((s) => s.nonce)).toEqual([seen[0].nonce, seen[0].nonce]);
  });

  it('given a reconciler run that reads while the resend is at the seller, when the seller refuses the used nonce, then the resend answers and the next run settles the row', async () => {
    const { t, id } = await lostAndDue('recon-race-refused', '/refuse');
    const read = heldRead();
    const run = reconcile(read.clients);
    await read.reached;
    onProof.set('/refuse', async () => {
      used.add(seen[0].nonce.toLowerCase());
      read.go();
      await run;
    });

    const again = await pay(t, { url: url('/refuse'), idempotencyKey: 'recon-race-refused' }, deps());

    expect(again.structuredContent).toMatchObject({ state: 'unknown', paymentId: id });
    expect(again.content[0].text).toContain('A payment may have reached the seller');
    expect(await rowOf(id)).toMatchObject({ state: 'signed' });
    expect(seen.map((s) => s.nonce)).toEqual([seen[0].nonce, seen[0].nonce]);
    await getDb().update(payments).set({ reconcilingUntil: null }).where(eq(payments.id, id));
    await reconcile(clients);
    expect(await rowOf(id)).toMatchObject({ state: 'settled', kind: 'paid' });
  });

  it("given a reconciler run that reads while the resend is at the seller, then a replay repeats the seller's answer", async () => {
    const { t, id } = await lostAndDue('recon-race-3');
    const read = heldRead();
    const run = reconcile(read.clients);
    await read.reached;
    onProof.set('/lost', async () => {
      used.add(seen[0].nonce.toLowerCase());
      read.go();
      await run;
    });
    const again = await pay(t, { url: url('/lost'), idempotencyKey: 'recon-race-3' }, deps());
    const replay = await pay(t, { url: url('/lost'), idempotencyKey: 'recon-race-3' }, deps());
    expect(again.content[1].text).toContain('the weather is fine');
    expect(replay).toEqual(again);
    expect(await rowOf(id)).toMatchObject({ state: 'settled', httpStatus: 200, txHash: TX(2) });
  });

  it('given a lost answer whose proof deadline passed, then a resend does not send it', async () => {
    const { t, id } = await lostAndDue('recon-expired');
    await getDb().execute(sql`alter table payments disable trigger payments_guard`);
    await getDb().execute(sql`update payments set deadline = now() - interval '1 second' where id = ${id}`);
    await getDb().execute(sql`alter table payments enable trigger payments_guard`);
    const again = await pay(t, { url: url('/lost'), idempotencyKey: 'recon-expired' }, deps());
    expect(again.structuredContent).not.toMatchObject({ kind: 'paid' });
    expect(seen).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ state: 'signed', code: 'no_response' });
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
      payerRefilled: true,
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
    expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled', payerRefilled: true });
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
    expect(result.structuredContent).toMatchObject({ kind: 'paid', payerRefilled: true });
    expect(reservedDuringWait.length).toBeGreaterThan(0);
    expect(reservedDuringWait.every((reserved) => reserved === null)).toBe(true);
  });

  it('given a top-up send that moved money and has not returned, then the row already carries its amount, and its batch id once it returns', async () => {
    const { t } = await connected('1');
    const during: { sending?: string | null; confirming?: string | null } = {};
    const watching = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        const sent = await executor(funder).request(method, params);
        const [row] = await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'write-ahead'));
        if (method === 'wallet_sendCalls') during.sending = row.topUpAmount;
        else during.confirming ??= row.topUpBatchId;
        return sent;
      },
    });
    const result = await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'write-ahead' },
      deps({ executor: (_t, grant) => watching(grant.account) })
    );
    expect(during).toEqual({ sending: refills[0].toString(), confirming: '0xbatch1' });
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ topUpAmount: refills[0].toString() });
  });

  it('given a top-up send that throws, then the payment is refused unsigned and the row keeps the amount it may have moved', async () => {
    const { t } = await connected('1');
    const refusing: TopUpExecutor = {
      request: async () => {
        throw new Error('the permission refused the transfer');
      },
    };
    const result = await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'send-threw' },
      deps({ executor: () => refusing })
    );
    expect(result.structuredContent).toMatchObject({
      kind: 'refused',
      state: 'failed',
      refusal: { code: 'funding_failed' },
    });
    expect(result.structuredContent?.payment).toBeUndefined();
    expect(seen).toHaveLength(0);
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({
      topUpAmount: '105000',
      topUpBatchId: null,
    });
  });

  it('given a top-up that lands but whose send throws, then a lowered budget still counts it', async () => {
    const { c, t } = await connected('2');
    const lostReply = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        await executor(funder).request(method, params);
        if (method === 'wallet_sendCalls') throw new Error('bundler reply lost');
        return { status: 200 };
      },
    });
    await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'lost-reply' },
      deps({ floatTarget: 1_900_000n, executor: (_t, grant) => lostReply(grant.account) })
    );
    expect(refills).toEqual([2_000_000n]);
    balances.set(t.sessionAddress.toLowerCase(), 0n);
    await approveBudget(c, '1');
    const after = await pay(t, { url: url('/exact'), idempotencyKey: 'lost-reply-new' }, deps());
    expect(after.structuredContent).toMatchObject({ refusal: { code: 'budget_exhausted' } });
    expect(refills).toEqual([2_000_000n]);
  });

  it('given a top-up whose answer is lost after it was signed, then the row keeps the amount and the signed hash', async () => {
    const { t } = await connected('1');
    const signedHash: Hex = `0x${'5'.repeat(64)}`;
    const lost = (funder: Address): TopUpExecutor => ({
      request: async (method, params, onSigned) => {
        if (method !== 'wallet_sendCalls') return { status: 200 };
        await onSigned?.(signedHash);
        await executor(funder).request(method, params);
        throw new Error('bundler reply lost');
      },
    });

    const result = await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'lost-signed' },
      deps({ executor: (_t, grant) => lost(grant.account) })
    );

    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({
      topUpAmount: refills[0].toString(),
      topUpBatchId: signedHash,
    });
  });

  const refusedInSimulation = () =>
    getUserOperationError(
      new RpcRequestError({
        body: { method: 'eth_sendUserOperation' },
        error: { code: -32521, message: 'execution reverted' },
        url: 'http://bundler.test',
      }) as never,
      { sender: '0x2222222222222222222222222222222222222222', nonce: 0n, callData: '0x', signature: '0x' } as never
    );
  const signing = (funder: Address, signedHash: Hex, after: () => Promise<unknown>): TopUpExecutor => ({
    request: async (method, params, onSigned) => {
      if (method !== 'wallet_sendCalls') return executor(funder).request(method, params);
      await onSigned?.(signedHash);
      return after();
    },
  });

  it('given the bundler answers a top-up with another hash than the one signed, then the row keeps the bundler hash and it is logged', async () => {
    const { t } = await connected('1');
    const signedHash: Hex = `0x${'1'.repeat(64)}`;
    const lines = await logsOf(async () => {
      const result = await pay(
        t,
        { url: url('/exact'), idempotencyKey: 'topup-mismatch' },
        deps({
          executor: (_t, g) => ({
            request: async (method, params, onSigned) => {
              if (method !== 'wallet_sendCalls') return executor(g.account).request(method, params);
              await onSigned?.(signedHash);
              await executor(g.account).request(method, params);
              return { id: `0x${'2'.repeat(64)}` };
            },
          }),
        })
      );
      expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ topUpBatchId: `0x${'2'.repeat(64)}` });
    });
    expect(lines).toContain(`bundler returned another userOp hash than ${signedHash}`);
  });

  it('given the top-up hash cannot be written, then the top-up is not sent and the row keeps no amount', async () => {
    const { t } = await connected('1');
    const drop = await failUpdates('hash-fails', 'new.top_up_batch_id is not null');
    let result: Awaited<ReturnType<typeof pay>> | undefined;
    try {
      result = await pay(
        t,
        { url: url('/exact'), idempotencyKey: 'hash-fails' },
        deps({ executor: (_t, g) => signing(g.account, `0x${'7'.repeat(64)}`, async () => ({ id: '0xsent' })) })
      );
    } finally {
      await drop();
    }
    expect(refills).toEqual([]);
    expect(await rowOf(result!.structuredContent!.paymentId)).toMatchObject({ topUpAmount: null, topUpBatchId: null });
  });

  it('given the bundler refuses a signed top-up in simulation, then the row keeps neither its amount nor its hash', async () => {
    const { t } = await connected('1');
    const result = await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'topup-refused' },
      deps({
        executor: (_t, g) =>
          signing(g.account, `0x${'8'.repeat(64)}`, async () => {
            throw refusedInSimulation();
          }),
      })
    );
    expect(result.structuredContent).toMatchObject({ payerRefilled: false });
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ topUpAmount: null, topUpBatchId: null });
  });

  it('given the bundler refuses a signed Permit2 approval in simulation, then the row keeps no approval hash', async () => {
    const { t } = await connected('1');
    const approving = (funder: Address): TopUpExecutor => ({
      ...executor(funder),
      approvePermit2: async (_token, onSigned) => {
        await onSigned?.(`0x${'9'.repeat(64)}`);
        throw refusedInSimulation();
      },
    });
    const result = await pay(
      t,
      { url: url('/upto'), idempotencyKey: 'approval-refused' },
      deps({ executor: (_t, g) => approving(g.account) })
    );
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ approvalBatchId: null });
  });

  it('given a Permit2 approval whose answer is lost after it was signed, then the row keeps the signed hash', async () => {
    const { t } = await connected('1');
    const signedHash: Hex = `0x${'6'.repeat(64)}`;
    const approving = (funder: Address): TopUpExecutor => ({
      ...executor(funder),
      approvePermit2: async (_token, onSigned) => {
        await onSigned?.(signedHash);
        throw new Error('bundler reply lost');
      },
    });

    const result = await pay(
      t,
      { url: url('/upto'), idempotencyKey: 'approval-lost' },
      deps({ executor: (_t, grant) => approving(grant.account) })
    );

    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ approvalBatchId: signedHash });
  });

  it('given a top-up send that returns no id, then the row keeps the amount and money moved', async () => {
    const { t } = await connected('1');
    const silent = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        await executor(funder).request(method, params);
        return null;
      },
    });
    const result = await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'no-id' },
      deps({ executor: (_t, grant) => silent(grant.account) })
    );
    expect(result.structuredContent).toMatchObject({ kind: 'refused', payerRefilled: true });
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ topUpAmount: refills[0].toString() });
  });

  it('given the write-ahead of the top-up amount fails, then nothing is sent and the turn fails as a database error, not a refusal on chain', async () => {
    const { t } = await connected('1');
    const drop = await failUpdates('add-fails', 'old.top_up_amount is null and new.top_up_amount is not null');
    let result: Awaited<ReturnType<typeof pay>> | undefined;
    try {
      const lines = await logsOf(async () => {
        result = await pay(t, { url: url('/exact'), idempotencyKey: 'add-fails' }, deps());
      });
      expect(lines).toContain('payment funding_failed: payer funding failed');
      expect(lines).not.toContain('refused on-chain');
    } finally {
      await drop();
    }
    expect(result?.structuredContent).toMatchObject({ refusal: { code: 'funding_failed' }, payerRefilled: false });
    expect([seen.length, refills.length]).toEqual([0, 0]);
  });

  it('given a top-up send that throws, then the refusal keeps the send error', async () => {
    const { t } = await connected('1');
    const refusing: TopUpExecutor = {
      request: async () => {
        throw new Error('the permission refused the transfer');
      },
    };
    const lines = await logsOf(() =>
      pay(t, { url: url('/exact'), idempotencyKey: 'send-error' }, deps({ executor: () => refusing }))
    );
    expect(lines).toContain('top-up refused on-chain (the permission refused the transfer)');
  });

  it('given a 5 USDC/day budget and a 2 USDC price, when the agent pays, then over_cap pointing at a larger budget, nothing signed or pulled', async () => {
    const { t } = await connected('5');
    const first = await pay(t, { url: url('/pricey'), idempotencyKey: 'pricey' }, deps());
    expect(first.structuredContent).toMatchObject({
      kind: 'refused',
      refusal: { code: 'over_cap', next: 'jaw_grant_permissions' },
      payerRefilled: false,
    });
    expect(first.structuredContent?.summary).toContain('jaw_grant_permissions');
    expect([seen.length, refills.length]).toEqual([0, 0]);
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
    // Probes run one at a time. A replica opens two float sessions per connection, so
    // two probes and a payment's funding turn would get one refused at once.
    onProof.set(
      '/slow',
      async () =>
        void lockFree.push(await inTurn(`probe:${t.connectionId}`, () => lockFreeWithin(t.connectionId, 2_000)))
    );
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
    // The first signed payment stays unsettled until the other payment has answered, so
    // only its reservation, not a spent balance, keeps the other from signing.
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    let held = false;
    onProof.set('/slow', async () => {
      if (held) return;
      held = true;
      await answered;
    });
    const results = await Promise.all(
      [1, 2].map((n) =>
        pay(t, { url: url('/slow'), idempotencyKey: `norefill-${n}` }, deps({ executor: () => undefined })).finally(
          release
        )
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
      refusal: { code: 'budget_exhausted', next: 'jaw_grant_permissions' },
      payerRefilled: false,
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

  it('given a payer that needs a refill, when the day spent so far cannot be read from the chain, then it is refused chain_unavailable before signing or refilling', async () => {
    const { t } = await connected('1');
    periodDown = true;
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'day-unreadable' }, deps());
    expect(result.structuredContent).toMatchObject({
      kind: 'refused',
      state: 'failed',
      refusal: { code: 'chain_unavailable' },
      payerRefilled: false,
    });
    expect(seen).toEqual([]);
    expect(refills).toEqual([]);
  });

  it('given a token with wallet:read alone on a connection with a budget, when it pays, then it is refused insufficient_scope naming x402:pay', async () => {
    const { t } = await connected('1');
    const result = await pay(
      { ...t, scopes: ['wallet:read'] },
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
      const result = await pay({ ...t, scopes: ['wallet:read'] }, { url: url('/exact') }, deps());
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
    expect(result.structuredContent).toMatchObject({ kind: 'free', state: 'settled', payerRefilled: false });
    expect(result.structuredContent?.idempotencyKey).toMatch(/^auto_/);
    expect(result.structuredContent?.responseTruncated).toBeUndefined();
  });

  it('given a body over 1 MB, when it passes through, then the answer says it was cut at 1 MB', async () => {
    const { t } = await connected('1');
    const result = await pay(t, { url: url('/huge') }, deps());
    expect(result.structuredContent).toMatchObject({ kind: 'free', state: 'settled', responseTruncated: true });
    expect(result.content[0].text).toContain('cut at 1 MB');
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
    expect(second.structuredContent).toMatchObject({ kind: 'paid', payerRefilled: false });
    expect(refills).toEqual([]);
  });

  it('settles a payment once its receipt shows up after the answer was sent', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const paid = await pay(t, { url: url('/late'), idempotencyKey: 'late-1' }, deps());
    expect(paid.structuredContent).toMatchObject({ state: 'signed', kind: 'paid' });

    const running = Promise.all(laterTasks.map((task) => task()));
    await sleep(50);
    for (const [tx, r] of minedLater) receipts.set(tx, r);
    await running;
    expect(await rowOf(paid.structuredContent!.paymentId)).toMatchObject({
      state: 'settled',
      amount: '5000',
      txHash: paid.structuredContent?.payment?.txHash,
      blockTime: new Date(1_790_000_000_000),
    });
  });

  it('keeps waiting for a receipt past the in-call wait once the answer is out', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const paid = await pay(t, { url: url('/late'), idempotencyKey: 'late-3' }, deps());
    const running = Promise.all(laterTasks.map((task) => task()));
    await sleep(3_500);
    for (const [tx, r] of minedLater) receipts.set(tx, r);
    await running;
    expect((await rowOf(paid.structuredContent!.paymentId)).state).toBe('settled');
  });

  it('logs a late settle that fails instead of leaving it unhandled', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const paid = await pay(t, { url: url('/late'), idempotencyKey: 'late-4' }, deps());
    for (const [tx, r] of minedLater) receipts.set(tx, r);
    const drop = await failUpdates('late-4', "new.state = 'settled'");
    try {
      const lines = await logsOf(async () => {
        await Promise.all(laterTasks.map((task) => task()));
      });
      expect(lines).toContain(`late settle ${paid.structuredContent!.paymentId} failed`);
    } finally {
      await drop();
    }
  });

  it('leaves a payment signed for the reconciler when its receipt never shows up', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const paid = await pay(t, { url: url('/late'), idempotencyKey: 'late-2' }, deps());
    minedLater.clear();
    await Promise.all(laterTasks.map((task) => task()));
    expect((await rowOf(paid.structuredContent!.paymentId)).state).toBe('signed');
  });

  it('settles in the call when the node asked for the block is behind the one that had the receipt', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    blocksBehind = 2;
    const paid = await pay(t, { url: url('/exact'), idempotencyKey: 'behind-1' }, deps());
    expect(paid.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
    expect(laterTasks).toEqual([]);
  });

  it('does not ask again for a block that failed for any other reason', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    blockDown = true;
    const paid = await pay(t, { url: url('/exact'), idempotencyKey: 'down-1' }, deps());
    expect(paid.structuredContent).toMatchObject({ kind: 'paid', state: 'signed' });
    expect(blockReads).toBe(1);
  });

  it('answers a paid call even when the settle after it cannot be scheduled', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    blockDown = true;
    const outside = () => {
      throw new Error('after() was called outside a request scope');
    };
    const paid = await pay(t, { url: url('/exact'), idempotencyKey: 'outside-1' }, deps({ later: outside }));
    expect(paid.structuredContent).toMatchObject({ kind: 'paid', state: 'signed', httpStatus: 200 });
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

  it.skipIf(!TEST_PG_URL).each(['the proven', 'the unproven'])(
    'given two payments of one payer whose seller names the same transaction at once and %s row writes last, then each answers from its row, the proven one settles on the hash and the other waits without it',
    async (last) => {
      const { t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
      onProof.set('/sametx', barrier(2));
      const keys = [`same-at-once-${last.replace(' ', '-')}-a`, `same-at-once-${last.replace(' ', '-')}-b`];
      // A proven row reads its block after the receipt; a row the receipt does not prove is concluded signed.
      if (last === 'the proven') blocksBehind = 1;
      const slow =
        last === 'the unproven'
          ? await Promise.all(keys.map((k) => slowUpdates(k, "new.state = 'signed' and new.kind = 'paid'", 1)))
          : [];
      try {
        const results = await Promise.allSettled(
          keys.map((k) => pay(t, { url: url('/sametx'), idempotencyKey: k }, deps()))
        );
        const reasons = results.flatMap((r) =>
          r.status === 'rejected' ? [String((r.reason as Error).cause ?? r.reason)] : []
        );
        expect(reasons).toEqual([]);
      } finally {
        for (const drop of slow) await drop();
      }
      const rows = await getDb().select().from(payments).where(inArray(payments.idempotencyKey, keys));
      // The receipt names the nonce the seller settled last; the other row is left to the reconciler.
      const proven = receipts.get(TX(999))!.nonce.toLowerCase();
      const byState = rows.sort((a, b) => (a.state < b.state ? 1 : -1));
      expect(byState.map(({ state, kind, amount, txHash, nonce }) => ({ state, kind, amount, txHash, nonce }))).toEqual(
        [
          {
            state: 'signed',
            kind: 'paid',
            amount: PRICES['/sametx'],
            txHash: null,
            nonce: expect.not.stringMatching(proven),
          },
          { state: 'settled', kind: 'paid', amount: PRICES['/sametx'], txHash: TX(999), nonce: proven },
        ]
      );
    }
  );

  it('given the conclusion write fails for a reason other than a taken hash, then the row is not concluded without its hash', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const drop = await failUpdates('hash-write-fails', 'new.tx_hash is not null');
    try {
      await pay(t, { url: url('/exact'), idempotencyKey: 'hash-write-fails' }, deps()).catch(() => undefined);
      const [row] = await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'hash-write-fails'));
      expect(row).toMatchObject({ kind: null, txHash: null });
    } finally {
      await drop();
    }
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

  it('lists payments newest first in jaw_session_history, scoped to the connection', async () => {
    const { c, t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    await pay(t, { url: url('/exact'), idempotencyKey: 'h1' }, deps());
    await pay(t, { url: url('/exact'), idempotencyKey: 'h2' }, deps());
    const listed = await callTool(c.access_token, 'jaw_session_history', { limit: 1 });
    expect(listed.structuredContent.payments).toHaveLength(1);
    expect(listed.structuredContent.payments[0]).toMatchObject({ idempotencyKey: 'h2', state: 'settled' });
    const next = await callTool(c.access_token, 'jaw_session_history', {
      limit: 5,
      before: listed.structuredContent.next,
    });
    expect(next.structuredContent.payments.map((p: { idempotencyKey: string }) => p.idempotencyKey)).toEqual(['h1']);
    const stranger = await connected();
    expect((await callTool(stranger.c.access_token, 'jaw_session_history', {})).structuredContent.payments).toEqual([]);
  });
});

describe('the raw body kept for an internal caller', () => {
  const refusalOf = (write: Promise<unknown>) =>
    write.then(
      () => 'written',
      (e: Error & { cause?: Error }) => e.cause?.message ?? e.message
    );

  it('given keepBody, when the payment settles, then the call carries the raw body off the wire and the row stores it', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'raw-paid' }, deps(), { keepBody: true });
    expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
    expect(JSON.parse(result[rawBody] as string)).toEqual({ report: 'the weather is fine' });
    expect(JSON.stringify(result)).not.toContain('{"report"');
    expect((await rowOf(result.structuredContent!.paymentId)).body).toBe(result[rawBody]);
  });

  it('given a stored keepBody payment, when the key is sent again, then the replay returns the raw body without paying', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const first = await pay(t, { url: url('/exact'), idempotencyKey: 'raw-replay' }, deps(), { keepBody: true });
    const again = await pay(t, { url: url('/exact'), idempotencyKey: 'raw-replay' }, deps(), { keepBody: true });
    expect(first[rawBody]).toBeDefined();
    expect(again[rawBody]).toBe(first[rawBody]);
    expect(again.structuredContent).toEqual(first.structuredContent);
    expect(seen).toHaveLength(1);
  });

  it('given keepBody and a lost answer, when the key is retried and the resend is paid, then the raw body is kept', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    dropNextLost = true;
    const lost = await pay(t, { url: url('/lost'), idempotencyKey: 'raw-lost' }, deps(), { keepBody: true });
    expect(lost.structuredContent).toMatchObject({ state: 'signed', refusal: { code: 'no_response' } });
    expect(lost[rawBody]).toBeUndefined();
    const retried = await pay(t, { url: url('/lost'), idempotencyKey: 'raw-lost' }, deps(), { keepBody: true });
    expect(retried.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
    expect(JSON.parse(retried[rawBody] as string)).toEqual({ report: 'the weather is fine' });
  });

  it('given keepBody and a refusal the key may retry, when the seller sent a body, then the call answers and keeps no raw body', async () => {
    const { t } = await connected('5');
    const result = await pay(t, { url: url('/pricey'), idempotencyKey: 'raw-refused' }, deps(), { keepBody: true });
    expect(result.structuredContent).toMatchObject({ kind: 'refused', refusal: { code: 'over_cap' } });
    expect(result[rawBody]).toBeUndefined();
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({
      state: 'pending',
      code: 'over_cap',
      body: null,
    });
  });

  const serving = (body: BodyInit | null) => deps({ fetch: async () => new Response(body) });
  const kept = async (body: BodyInit | null, idempotencyKey?: string) => {
    const { t } = await connected('1');
    const result = await pay(t, { url: url('/free'), idempotencyKey }, serving(body), { keepBody: true });
    return { result, row: await rowOf(result.structuredContent!.paymentId) };
  };

  it('given keepBody and a body over 16384 bytes, when it passes through, then no raw body is kept rather than a cut one', async () => {
    const { t } = await connected('1');
    const result = await pay(t, { url: url('/huge') }, deps(), { keepBody: true });
    expect(result.structuredContent).toMatchObject({ kind: 'free', state: 'settled' });
    expect(result[rawBody]).toBeUndefined();
    expect((await rowOf(result.structuredContent!.paymentId)).body).toBeNull();
  });

  it('given keepBody and a body of exactly 16384 bytes, when it passes through, then it is kept whole', async () => {
    const { result, row } = await kept('é'.repeat(8_192));
    expect(result[rawBody]).toBe('é'.repeat(8_192));
    expect(row.body).toBe('é'.repeat(8_192));
  });

  it('given keepBody and a body one byte over 16384 in fewer characters, when it passes through, then no raw body is kept', async () => {
    const { result, row } = await kept(`${'é'.repeat(8_192)}x`);
    expect(result[rawBody]).toBeUndefined();
    expect(row.body).toBeNull();
  });

  it('given keepBody and an é whose second byte is byte 16385, when it passes through, then no raw body is kept, not the text before the é', async () => {
    const { result, row } = await kept(`${'x'.repeat(16_383)}é`);
    expect(result[rawBody]).toBeUndefined();
    expect(row.body).toBeNull();
  });

  it('given keepBody and an é that ends on byte 16384, when it passes through, then it is kept whole', async () => {
    const { result, row } = await kept(`${'x'.repeat(16_382)}é`);
    expect(result[rawBody]).toBe(`${'x'.repeat(16_382)}é`);
    expect(row.body).toBe(`${'x'.repeat(16_382)}é`);
  });

  it('given keepBody and the bytes a 0xFF b, when they are stored, then the text is a U+FFFD b', async () => {
    const { result, row } = await kept(new Uint8Array([0x61, 0xff, 0x62]));
    expect(result[rawBody]).toBe('a\uFFFDb');
    expect(row.body).toBe('a\uFFFDb');
  });

  it('given keepBody and a body cut inside an é, when it is stored, then the text is a U+FFFD', async () => {
    const { result, row } = await kept(new Uint8Array([0x61, 0xc3]));
    expect(result[rawBody]).toBe('a\uFFFD');
    expect(row.body).toBe('a\uFFFD');
  });

  it('given keepBody and 16384 bytes whose invalid ones decode to 16392 bytes of text, when it passes through, then no raw body is kept and the database is never offered it', async () => {
    const bytes = new Uint8Array(16_384).fill(0x61);
    bytes.fill(0xff, 16_380);
    let kept16392: Awaited<ReturnType<typeof kept>> | undefined;
    const logs = await logsOf(async () => (kept16392 = await kept(bytes)));
    expect(kept16392?.result[rawBody]).toBeUndefined();
    expect(kept16392?.row.body).toBeNull();
    expect(logs).not.toContain('concluded without its body');
  });

  it('given keepBody and a JSON body with an integer past 2^53, when it is kept, then the raw body holds the digits the seller sent', async () => {
    const { result, row } = await kept('{"amount":123456789012345678901}');
    expect(result[rawBody]).toBe('{"amount":123456789012345678901}');
    expect(row.body).toBe('{"amount":123456789012345678901}');
  });

  it('given keepBody and an empty body, when it is kept, then the raw body is empty, not {}', async () => {
    const { result, row } = await kept('');
    expect(result[rawBody]).toBe('');
    expect(row.body).toBe('');
  });

  it('given keepBody and a response with no body at all, when it is kept, then the raw body is empty', async () => {
    const { result, row } = await kept(null);
    expect(result[rawBody]).toBe('');
    expect(row.body).toBe('');
  });

  it('given keepBody and a signed proof that never reached the seller, when it concludes, then the 402 before it is not kept as the body', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const live = safeFetch(new Set([SELLER]));
    const blockedProof: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).has('payment-signature')) throw new FetchRefused('blocked');
      return live(input, init);
    };
    const result = await pay(t, { url: url('/exact') }, deps({ fetch: blockedProof }), { keepBody: true });
    expect(result.structuredContent).toMatchObject({ state: 'unknown', refusal: { code: 'blocked_url' } });
    expect(result[rawBody]).toBeUndefined();
    expect((await rowOf(result.structuredContent!.paymentId)).body).toBeNull();
  });

  it('given keepBody and a body the agent replaced with its own error past 2 MB, when it concludes, then no raw body is kept', async () => {
    const { result, row } = await kept('y'.repeat(2 * 1024 * 1024 + 1));
    expect(result.structuredContent).toMatchObject({ kind: 'free', state: 'settled' });
    expect(result[rawBody]).toBeUndefined();
    expect(row.body).toBeNull();
  });

  it('given keepBody and a body holding NUL bytes, when it is stored, then each NUL is kept as U+FFFD and the payment concludes', async () => {
    const { result, row } = await kept('a\u0000b\u0000');
    expect(result.structuredContent).toMatchObject({ kind: 'free', state: 'settled' });
    expect(result[rawBody]).toBe('a\uFFFDb\uFFFD');
    expect(row).toMatchObject({ state: 'settled', body: 'a\uFFFDb\uFFFD' });
  });

  it.each([
    ['the payment_body check', "using errcode = 'check_violation', constraint = 'payment_body'"],
    ['an invalid byte sequence', "using errcode = 'character_not_in_repertoire'"],
  ])(
    'given keepBody and a body Postgres rejects with %s, when the payment settles, then the conclusion lands without the body',
    async (_, using) => {
      const { t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
      const key = `raw-refused-${randomUUID()}`;
      const drop = await failUpdates(key, 'new.body is not null', using);
      try {
        const result = await pay(t, { url: url('/exact'), idempotencyKey: key }, deps(), { keepBody: true });
        expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
        expect(result[rawBody]).toBeUndefined();
        expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ state: 'settled', body: null });
        const again = await pay(t, { url: url('/exact'), idempotencyKey: key }, deps(), { keepBody: true });
        expect(again.structuredContent).toEqual(result.structuredContent);
        expect(seen).toHaveLength(1);
      } finally {
        await drop();
      }
    }
  );

  it.each([
    ['a serialization failure', "using errcode = 'serialization_failure'"],
    ['a lock timeout', "using errcode = 'lock_not_available'"],
    ['another check', "using errcode = 'check_violation', constraint = 'payment_shape'"],
    ['an error raised by a trigger', ''],
  ])(
    'given keepBody and a conclusion write with its body that fails with %s, when the payment settles, then the row is not concluded without the body',
    async (_, using) => {
      const { t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
      const key = `raw-other-${randomUUID()}`;
      const drop = await failUpdates(key, 'new.body is not null', using);
      try {
        const result = await pay(t, { url: url('/exact'), idempotencyKey: key }, deps(), { keepBody: true });
        expect(JSON.parse(result[rawBody] as string)).toEqual({ report: 'the weather is fine' });
        expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ state: 'signed', body: null });
      } finally {
        await drop();
      }
    }
  );

  it('given keepBody and a conclusion write that fails, when the call answers, then it still carries the raw body it read', async () => {
    const drop = await failUpdates('raw-unwritten', 'new.kind is not null');
    try {
      const { result, row } = await kept('{"quote":1}', 'raw-unwritten');
      expect(row.kind).toBeNull();
      expect(result.structuredContent).toMatchObject({ kind: 'free', state: 'settled' });
      expect(result[rawBody]).toBe('{"quote":1}');
    } finally {
      await drop();
    }
  });

  it('given jaw_session_x402_pay, when an idempotency key claims the swap: namespace, then it is refused and nothing is claimed', async () => {
    const { c } = await connected('1');
    const swapKey = await callTool(c.access_token, 'jaw_session_x402_pay', {
      url: url('/free'),
      idempotencyKey: 'swap:abc:1',
    });
    expect(swapKey.isError).toBe(true);
    await callTool(c.access_token, 'jaw_session_x402_pay', { url: url('/free'), idempotencyKey: 'swap-abc-1' });
    const claimed = await getDb()
      .select({ key: payments.idempotencyKey })
      .from(payments)
      .where(inArray(payments.idempotencyKey, ['swap:abc:1', 'swap-abc-1']));
    expect(claimed).toEqual([{ key: 'swap-abc-1' }]);
  });

  it('given jaw_session_x402_pay, when it pays, then its row keeps no raw body and its answer only the fenced one', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const result = await pay(t, { url: url('/exact'), idempotencyKey: 'raw-tool' }, deps());
    expect(rawBody in result).toBe(false);
    expect(result.structuredContent?.response).toEqual([result.content[1].text]);
    expect((await rowOf(result.structuredContent!.paymentId)).body).toBeNull();
  });

  it('given a signed row holding a raw body, when anything rewrites it, then the database refuses', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const result = await pay(t, { url: url('/unconfirmed') }, deps(), { keepBody: true });
    const id = result.structuredContent!.paymentId;
    expect(await rowOf(id)).toMatchObject({ state: 'signed', body: '{}' });
    expect(await refusalOf(getDb().execute(sql`update payments set body = 'other' where id = ${id}`))).toMatch(
      /the body is written once/
    );
    expect((await rowOf(id)).body).toBe('{}');
  });

  it('given a signed row without a body, when 16385 bytes in 8193 characters are written, then the database refuses and 16384 bytes it accepts', async () => {
    const { t } = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const result = await pay(t, { url: url('/unconfirmed') }, deps());
    const id = result.structuredContent!.paymentId;
    expect(await rowOf(id)).toMatchObject({ state: 'signed', body: null });
    expect(
      await refusalOf(getDb().execute(sql`update payments set body = repeat('é', 8193) where id = ${id}`))
    ).toMatch(/payment_body/);
    await getDb().execute(sql`update payments set body = repeat('é', 8192) where id = ${id}`);
    expect((await rowOf(id)).body).toBe('é'.repeat(8_192));
  });

  it('given a body and a lease another call took, when finish writes, then nothing is concluded and the row keeps its state', async () => {
    const { t } = await connected('1');
    const claimed = await claim(
      { connectionId: t.connectionId, payer: t.sessionAddress, permissionId: 'p' },
      'raw-lost-lease',
      { url: url('/exact'), method: 'GET', headers: {} }
    );
    if (claimed.kind !== 'run') throw new Error(`claimed ${claimed.kind}`);
    const written = await finish(claimed.row.id, randomUUID(), { state: 'settled', kind: 'free', body: 'kept' }, []);
    expect(written).toBeUndefined();
    expect(await rowOf(claimed.row.id)).toMatchObject({ state: 'pending', kind: null, body: null });
  });

  it('given a pending row, when a raw body is written on it, then the database refuses', async () => {
    const { t } = await connected('1');
    const claimed = await claim(
      { connectionId: t.connectionId, payer: t.sessionAddress, permissionId: 'p' },
      'raw-pending',
      { url: url('/exact'), method: 'GET', headers: {} }
    );
    if (claimed.kind !== 'run') throw new Error(`claimed ${claimed.kind}`);
    const id = claimed.row.id;
    expect(await refusalOf(getDb().execute(sql`update payments set body = 'early' where id = ${id}`))).toMatch(
      /payment_body/
    );
  });
});

describe('given a pay request that verified its bearer before the connection was disconnected', () => {
  // What jaw_session_disconnect does once its batch landed: end the connection under the float lock.
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
      payerRefilled: false,
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

describe('given a pay request that verified its bearer before its client revoked it', () => {
  it('when its refill turn comes after the revoke committed, then it refuses, reserves nothing and signs nothing', async () => {
    const { t } = await connected('1');
    const revoke = await revoker(t);
    onProbe.set('/race', async () => {
      expect((await revoke())?.connection.status).toBe('revoked');
    });
    const result = await pay(t, { url: url('/race'), idempotencyKey: 'page-race-refill' }, deps());
    expect(result.structuredContent).toMatchObject({
      kind: 'refused',
      payerRefilled: false,
      refusal: { code: 'not_allowed' },
    });
    expect(refills).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ reserved: null, nonce: null });
  });

  it('when the revoke commits after its refill, then the pay still settles', async () => {
    const { t } = await connected('1');
    const revoke = await revoker(t);
    let revoked: Awaited<ReturnType<typeof revoke>> | undefined;
    onProof.set('/race', async () => {
      revoked = await revoke();
    });
    const result = await pay(t, { url: url('/race'), idempotencyKey: 'page-race-past-refill' }, deps());
    expect(revoked).toMatchObject({ connection: { status: 'revoked' } });
    expect(result.structuredContent).toMatchObject({ kind: 'paid', state: 'settled' });
    expect(refills).toEqual([105_000n]);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a pay inside its funding turn', () => {
  it('when its client revokes it, then the revoke waits for the turn and the next pay refuses', async () => {
    const { t } = await connected('1');
    const replica = await watchedReplica(t.connectionId);
    const revoke = await revoker(t, replica.revokeByGrant);
    let revoking: ReturnType<typeof revoke> | undefined;
    let statusInTurn: string | undefined;
    const inTurn = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        if (!revoking) {
          const waiting = replica.untilWaiting();
          revoking = revoke();
          await Promise.race([waiting, revoking]);
          const [row] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
          statusInTurn = row.status;
        }
        return executor(funder).request(method, params);
      },
    });
    const paid = await replica.pay(
      t,
      { url: url('/race'), idempotencyKey: 'page-in-turn' },
      deps({ executor: (_t, grant) => inTurn(grant.account) })
    );
    expect(statusInTurn).toBe('active');
    expect(paid.structuredContent).toMatchObject({ kind: 'paid' });
    expect(await revoking).toMatchObject({ connection: { status: 'revoked' } });

    const after = await pay(t, { url: url('/race'), idempotencyKey: 'page-after-turn' }, deps());
    expect(after.structuredContent).toMatchObject({ kind: 'refused', refusal: { code: 'not_allowed' } });
    expect(refills).toEqual([105_000n]);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a top-up in flight whose lock session dropped', () => {
  // Frees the lock under the refill's send, then runs `meanwhile` before the transfer lands.
  const dropThenLand =
    (t: Tenant, meanwhile: () => Promise<void>) =>
    (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        if (method === 'wallet_sendCalls') {
          await getDb().execute(sql`select pg_terminate_backend(pid) from pg_locks
            where locktype = 'advisory' and granted
              and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${t.connectionId}`})`);
          await meanwhile();
        }
        return executor(funder).request(method, params);
      },
    });
  const statusOf = async (id: string) =>
    (await getDb().select().from(connections).where(eq(connections.id, id)))[0].status;

  it('when its client revokes it, then the connection stays active until the pay concludes, and that revoke then ends it', async () => {
    const { t } = await connected('1');
    const revoke = await revoker(t);
    let revoking: ReturnType<typeof revoke> | undefined;
    let statusWhenLanded: string | undefined;
    const meanwhile = async () => {
      revoking = revoke();
      await sleep(1_500);
      statusWhenLanded = await statusOf(t.connectionId);
    };
    await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'drop-in-flight' },
      deps({ executor: (_t, g) => dropThenLand(t, meanwhile)(g.account) })
    );
    const revoked = await revoking;
    expect(refills).toEqual([105_000n]);
    expect(statusWhenLanded).toBe('active');
    expect(revoked?.connection.status).toBe('revoked');
  });

  it('when the agent disconnects, then it sends nothing and answers busy, and a disconnect after returns the top-up', async () => {
    const { t } = await connected('1');
    const { deps: session, sent } = sessionFakes();
    const disconnectDeps = { readPermission: approvedOnChain, clients, sender: session.sender };
    let during: Awaited<ReturnType<typeof disconnect>> | undefined;
    const meanwhile = async () => {
      during = await disconnect(t, disconnectDeps);
    };
    await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'drop-in-flight-disconnect' },
      deps({ executor: (_t, g) => dropThenLand(t, meanwhile)(g.account) })
    );
    expect(during?.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(refills).toEqual([105_000n]);

    const after = await disconnect(t, disconnectDeps);
    expect(after.structuredContent).toMatchObject({ swept: (105_000n - 2_500n).toString() });
    expect(await statusOf(t.connectionId)).toBe('revoked');
  });

  it('when a reused refresh token sweeps it, then the sweep waits for the top-up and returns it with the float', async () => {
    const { t } = await connected('1');
    const { deps: session, sent } = sessionFakes();
    const sweepDeps = { readPermission: approvedOnChain, clients, sender: session.sender };
    let sweeping: Promise<void> | undefined;
    let sentInFlight: unknown[] = [];
    const meanwhile = async () => {
      sweeping = sweepOnReuse(t.connectionId, t.sessionKey(), sweepDeps);
      await sleep(1_000);
      sentInFlight = [...sent];
    };
    await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'drop-in-flight-reuse' },
      deps({ executor: (_t, g) => dropThenLand(t, meanwhile)(g.account) })
    );
    await sweeping;
    expect(sentInFlight).toEqual([]);
    expect(refills).toEqual([105_000n]);
    expect(sent).toHaveLength(1);
    const swept = sent[0].flatMap(({ to, data }) => {
      if (to.toLowerCase() !== USDC.toLowerCase()) return [];
      const call = decodeFunctionData({ abi: erc20Abi, data });
      return call.functionName === 'transfer' ? [call.args[1]] : [];
    });
    expect(swept).toEqual([105_000n - 2_500n]);
    expect(await statusOf(t.connectionId)).toBe('revoked');
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
      payerRefilled: false,
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
    'when six 0.3 payments run at once across two replicas on Postgres, with each signature landing after the next turn, then three are paid, the rest refuse budget_exhausted holding nothing, and jaw_session_status shows what is left',
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
      expect(refused.every((r) => r.structuredContent?.refusal?.next === 'jaw_grant_permissions')).toBe(true);
      expect(seen).toHaveLength(3);
      for (const r of refused) {
        expect(await rowOf(r.structuredContent!.paymentId)).toMatchObject({ reserved: null, topUpAmount: null });
      }
      const status = await callTool(c.access_token, 'jaw_session_status', {});
      expect(status.structuredContent.float.amount).toBe('600000');
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

describe.skipIf(!TEST_PG_URL)('on Postgres, given a refill whose lock session is cut off without it knowing', () => {
  it('when another replica takes the lock and pays, then the two do not both pay past the cap', async () => {
    const { t } = await connected('0.3');
    balances.set(t.sessionAddress.toLowerCase(), 600_000n);
    const payB = await otherReplica();
    const holder = floatHolder();
    const proxy = await partitionable((holder as { url: string }).url);
    setDb(getDb(), { url: proxy.url });
    const admin = postgres(TEST_PG_URL as string, { max: 1, onnotice: () => {} });
    let killed = 0;
    let second: Awaited<ReturnType<typeof pay>> | undefined;
    const cutting: ChainClients = {
      publicClient: () =>
        ({
          ...node,
          readContract: async (read: Parameters<typeof node.readContract>[0]) => {
            const payerRead =
              read.functionName === 'balanceOf' && isAddressEqual(read.args[0] as Address, t.sessionAddress);
            if (payerRead && !second) {
              proxy.freeze();
              const rows = await admin`select pg_terminate_backend(pid) from pg_locks
                where locktype = 'advisory' and granted
                  and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${t.connectionId}`})`;
              killed = rows.length;
              second = await payB(t, { url: url('/budget'), idempotencyKey: 'replica-b-cap' }, deps());
            }
            return node.readContract(read);
          },
        }) as unknown as PublicClient,
    };
    let first: Awaited<ReturnType<typeof pay>> | undefined;
    try {
      first = await pay(t, { url: url('/budget'), idempotencyKey: 'replica-a-cap' }, deps({ clients: cutting }));
    } finally {
      setDb(getDb(), holder);
      await proxy.close();
      await admin.end();
    }
    expect(killed).toBe(1);
    expect([first?.structuredContent?.kind, second?.structuredContent?.kind].filter((k) => k === 'paid')).toHaveLength(
      1
    );
  });
});

describe.skipIf(!TEST_PG_URL)(
  'on Postgres, given a short payer whose lock session is cut off without it knowing',
  () => {
    it('when another replica takes the lock and tops up first, then the cut-off turn sends no top-up', async () => {
      const { t } = await connected('1');
      const payB = await otherReplica();
      const holder = floatHolder();
      const proxy = await partitionable((holder as { url: string }).url);
      setDb(getDb(), { url: proxy.url });
      const admin = postgres(TEST_PG_URL as string, { max: 1, onnotice: () => {} });
      let killed = 0;
      let second: Awaited<ReturnType<typeof pay>> | undefined;
      const cutting: ChainClients = {
        publicClient: () =>
          ({
            ...node,
            readContract: async (read: Parameters<typeof node.readContract>[0]) => {
              const payerRead =
                read.functionName === 'balanceOf' && isAddressEqual(read.args[0] as Address, t.sessionAddress);
              // The pinned read answers for the block before the other replica's top-up.
              const balance = await node.readContract(read);
              if (payerRead && !second) {
                proxy.freeze();
                const rows = await admin`select pg_terminate_backend(pid) from pg_locks
                where locktype = 'advisory' and granted
                  and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${t.connectionId}`})`;
                killed = rows.length;
                second = await payB(t, { url: url('/budget'), idempotencyKey: 'replica-b-topup' }, deps());
              }
              return balance;
            },
          }) as unknown as PublicClient,
      };
      let first: Awaited<ReturnType<typeof pay>> | undefined;
      try {
        first = await pay(t, { url: url('/budget'), idempotencyKey: 'replica-a-topup' }, deps({ clients: cutting }));
      } finally {
        setDb(getDb(), holder);
        await proxy.close();
        await admin.end();
      }
      expect(killed).toBe(1);
      expect(second?.structuredContent?.kind).toBe('paid');
      expect(refills).toHaveLength(1);
      expect(first?.structuredContent?.kind).not.toBe('paid');
    });
  }
);

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

describe.skipIf(!TEST_PG_URL)('on Postgres, given a funded turn whose reservation write fails', () => {
  it('when a payment on another replica takes the next turn, then only that one signs against the float', async () => {
    const { t } = await connected('1');
    const payB = await otherReplica();
    const dropReserve = await failUpdates('replica-a-float', 'old.reserved is null and new.reserved is not null');
    const slowSign = await slowUpdates('replica-a-float', "new.state = 'signed'", 2);
    let second: ReturnType<typeof pay> | undefined;
    const startSecond = (funder: Address): TopUpExecutor => ({
      request: async (method, params) => {
        if (method === 'wallet_sendCalls')
          second ??= payB(t, { url: url('/budget'), idempotencyKey: 'replica-b-float' }, deps());
        return executor(funder).request(method, params);
      },
    });
    let first: Awaited<ReturnType<typeof pay>>;
    try {
      first = await pay(
        t,
        { url: url('/budget'), idempotencyKey: 'replica-a-float' },
        deps({ executor: (_t, grant) => startSecond(grant.account) })
      );
      await second;
    } finally {
      await dropReserve();
      await slowSign();
    }
    expect(balanceOf(t.sessionAddress)).toBeGreaterThanOrEqual(0n);
    expect(first.structuredContent?.refusal?.code).toBe('funding_failed');
    expect((await second)?.structuredContent?.kind).toBe('paid');
    expect(seen).toHaveLength(1);
    expect(await rowOf(first.structuredContent!.paymentId)).toMatchObject({
      reserved: null,
      topUpAmount: refills[0].toString(),
    });
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given another holder took the float while the top-up was signed', () => {
  it('then its hash is not written, the top-up is not sent and the row keeps no amount', async () => {
    const { t } = await connected('1');
    const taken = (funder: Address): TopUpExecutor => ({
      request: async (method, params, onSigned) => {
        if (method !== 'wallet_sendCalls') return executor(funder).request(method, params);
        await getDb()
          .update(connections)
          .set({ floatFence: sql`${connections.floatFence} + 1` })
          .where(eq(connections.id, t.connectionId));
        await onSigned?.(`0x${'4'.repeat(64)}`);
        return executor(funder).request(method, params);
      },
    });
    const result = await pay(
      t,
      { url: url('/exact'), idempotencyKey: 'fence-moved' },
      deps({ executor: (_t, g) => taken(g.account) })
    );
    expect(refills).toEqual([]);
    expect(await rowOf(result.structuredContent!.paymentId)).toMatchObject({ topUpAmount: null, topUpBatchId: null });
  });
});

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
        payerRefilled: false,
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

  describe('the guard every migration since 0006 keeps', () => {
    const refusal = (q: ReturnType<typeof sql>) =>
      getDb()
        .execute(q)
        .then(
          () => 'written',
          (e: Error & { cause?: Error }) => e.cause?.message ?? e.message
        );

    it('refuses deleting a row, moving or rewriting a final one, and a move that is not a transition', async () => {
      const id = await settledRow();
      expect(await refusal(sql`delete from payments where id = ${id}`)).toMatch(/is never deleted/);
      expect(await refusal(sql`update payments set code = 'x' where id = ${id}`)).toMatch(/is settled and final/);
      const { t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
      const signed = (await pay(t, { url: url('/unconfirmed') }, deps())).structuredContent!.paymentId;
      expect((await rowOf(signed)).state).toBe('signed');
      expect(await refusal(sql`update payments set state = 'pending' where id = ${signed}`)).toMatch(
        /signed to pending is not a transition/
      );
    });

    it('refuses rewriting the request, the signed authorization, a live authorization to failed, or the fenced text', async () => {
      const { t } = await connected('1');
      balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
      const id = (await pay(t, { url: url('/unconfirmed') }, deps())).structuredContent!.paymentId;
      expect((await rowOf(id)).state).toBe('signed');
      expect(await refusal(sql`update payments set url = 'http://elsewhere' where id = ${id}`)).toMatch(
        /the request is immutable/
      );
      expect(await refusal(sql`update payments set nonce = '0x01' where id = ${id}`)).toMatch(
        /the signed authorization is immutable/
      );
      expect(await refusal(sql`update payments set state = 'failed', finished_at = now() where id = ${id}`)).toMatch(
        /a live authorization cannot fail/
      );
      expect(await refusal(sql`update payments set fenced = '["other"]' where id = ${id}`)).toMatch(
        /the fenced text is written once/
      );
      expect(await rowOf(id)).toMatchObject({ state: 'signed', url: url('/unconfirmed') });
    });

    it('as 0015 redefines it, keeps every rule of the 0013 definition it replaces', async () => {
      const { readFileSync } = await import('node:fs');
      const rules = (file: string) => {
        const sql = readFileSync(join(__dirname, '../../drizzle', file), 'utf8');
        const guard = sql.slice(sql.indexOf('"payments_guard"()'), sql.indexOf('END $$'));
        return (guard.match(/IF [\s\S]*?END IF;/g) ?? []).map((r) => r.replace(/\s+/g, ' '));
      };
      const before = rules('0013_wallet_relay.sql');
      expect(before).toHaveLength(7);
      expect(rules('0015_payment_body.sql')).toEqual([...before, expect.stringMatching(/the body is written once/)]);
    });
  });
});

// The funding turn's chain calls resolve in whatever order the scheduler picks: balance
// reads, the block number and the top-up send. `/budget` spends from the payer's float
// as the seller settles, so a payment signed against float another one holds drives it
// below zero. The database and the seller run outside the scheduler. A pause before
// each release lets every payment reach its next chain call, so the scheduler picks
// among them; no pause releases each call as it comes, which lets a signed payment
// stay unsettled while the next one reads the float.
const pauseThenRelease = async (release: () => Promise<void>) => {
  await sleep(10);
  await release();
};

describe('given concurrent payments whose chain calls resolve in any order', () => {
  it('then none signs against float another holds, and none pays or refills past the daily budget', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 2, max: 4 }),
        fc.constantFrom(0n, 300_000n),
        fc.boolean(),
        async (s, count, float, pause) => {
          const { t } = await connected('0.6');
          balances.set(t.sessionAddress.toLowerCase(), float);
          seen.length = 0;
          refills.length = 0;
          // Reads the node rejects stay off the scheduler: its wrapper would leave the rejection unhandled.
          const scheduledRead = s.scheduleFunction(node.readContract);
          const scheduled: ChainClients = {
            publicClient: () =>
              ({
                ...node,
                getBlockNumber: s.scheduleFunction(node.getBlockNumber),
                readContract: (read: Parameters<typeof node.readContract>[0]) =>
                  read.functionName === 'balanceOf' || read.functionName === 'authorizationState'
                    ? scheduledRead(read)
                    : node.readContract(read),
              }) as unknown as PublicClient,
          };
          const sendLater = (funder: Address): TopUpExecutor => ({
            request: async (method, params) => {
              await s.schedule(Promise.resolve(), method);
              return executor(funder).request(method, params);
            },
          });
          const over = deps({ clients: scheduled, executor: (_t, grant) => sendLater(grant.account) });
          const results = await s.waitFor(
            Promise.all(
              Array.from({ length: count }, () => pay(t, { url: url('/budget'), idempotencyKey: randomUUID() }, over))
            ),
            pause ? pauseThenRelease : undefined
          );

          const paid = results.filter((r) => r.structuredContent?.kind === 'paid').length;
          expect(balanceOf(t.sessionAddress)).toBeGreaterThanOrEqual(0n);
          expect(seen).toHaveLength(paid);
          expect(paid).toBeGreaterThan(0);
          expect(paid).toBeLessThanOrEqual(2);
          expect(refills.reduce((sum, amount) => sum + amount, 0n)).toBeLessThanOrEqual(600_000n);
        }
      ),
      { seed: 0x5ced, numRuns: 30 }
    );
  }, 120_000);
});
