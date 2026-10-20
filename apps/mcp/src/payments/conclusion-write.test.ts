import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChainClients, TopUpExecutor } from '@jaw.id/agent';
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
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  approvedOnChain,
  connect,
  fakeWallet,
  managerAnswer,
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, payments } from '@/db/schema';
import { x402Budget } from '@/grants/store';
import { grantPermissions } from '@/tools/grant-permissions';
import { TEST_PG_URL, useTestPostgres } from '@/db/test-db';
import { safeFetch } from '@/lib/safe-fetch';
import { pay, type PayDeps } from './pay';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const PRICE = '5000';
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const AUTHORIZATION_USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);

const seen: { nonce: Hex }[] = [];
const receipts = new Map<Hex, { from: Address; nonce: Hex }>();

/** Charges PRICE for every request and settles each proof in its own transaction. `/once` refuses a nonce it saw. */
const seller = createServer((req, res) => {
  const signed = req.headers['payment-signature'];
  if (!signed) {
    const challenge = {
      x402Version: 2,
      resource: { url: `http://${req.headers.host}${req.url}` },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: PRICE,
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2', facilitatorAddress: PAY_TO },
        },
      ],
    };
    return void res
      .writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') })
      .end('{}');
  }
  const proof = JSON.parse(Buffer.from(String(signed), 'base64').toString());
  const { nonce, from } = proof.payload.authorization;
  if (req.url === '/once' && seen.some((s) => s.nonce === nonce)) {
    return void res.writeHead(402, { 'payment-required': Buffer.from('{}').toString('base64') }).end('{}');
  }
  const tx = TX(seen.push({ nonce }) + 0x1000);
  receipts.set(tx, { from, nonce });
  const receipt = { success: true, transaction: tx, network: 'eip155:84532', payer: from };
  res
    .writeHead(200, { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') })
    .end(JSON.stringify({ report: 'the weather is fine' }));
});
await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r));
const SELLER = `127.0.0.1:${(seller.address() as AddressInfo).port}`;
const url = `http://${SELLER}/exact`;

let readFails = false;
let hashCheckFails = false;
vi.mock('./store', async (original) => {
  const store = await original<typeof import('./store')>();
  return {
    ...store,
    findPayment: (id: string) => (readFails ? Promise.reject(new Error('read refused')) : store.findPayment(id)),
    txHashTaken: (...args: Parameters<typeof store.txHashTaken>) =>
      hashCheckFails ? Promise.reject(new Error('read refused')) : store.txHashTaken(...args),
  };
});

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () => node as unknown as PublicClient,
}));

setTestEnv();
process.env.JAW_MCP_INSECURE_FETCH_HOSTS = SELLER;
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
    if (functionName === 'getHash' || functionName === 'getCurrentPeriod') return managerAnswer(functionName, args);
    throw new Error('this node only knows balances, nonces and the permission');
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
const lateTasks: (() => Promise<void>)[] = [];
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

const deps = (): PayDeps => ({
  clients,
  floatTarget: 0n,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  executor: (_t, grant) => executor(grant.account),
  fetch: safeFetch(new Set([SELLER])),
  later: (task) => void lateTasks.push(task),
});

beforeAll(async () => {
  if (TEST_PG_URL) await useTestPostgres();
});
beforeEach(() => {
  seen.length = 0;
  refills.length = 0;
  lateTasks.length = 0;
  readFails = false;
  hashCheckFails = false;
});

/** A connection with a budget of `perDay` and a funded account behind it. */
async function connected(perDay: string): Promise<Tenant> {
  const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));
  const wallet = fakeWallet(walletAnswers(c.signer));
  await grantPermissions(t, { x402Budget: { perDay } }, { openWallet: wallet, readPermission: approvedOnChain });
  await walletsSettled();
  if (!(await x402Budget(t.connectionId))) throw new Error('no budget');
  balances.set(c.signer.address.toLowerCase(), 5_000_000n);
  return t;
}

/** Makes Postgres refuse every update of this key's row that matches `when`, until the returned drop runs. */
async function failUpdates(key: string, when: string) {
  const name = `fail_${key.replaceAll('-', '_')}`;
  await getDb().execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
      if new.idempotency_key = '${key}' and (${when}) then raise exception '${key} write refused'; end if;
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

/** Pays once with every update matching `when` refused, and returns the answer or what was thrown. */
async function payWithFailedWrite(t: Tenant, key: string, when: string, to = url) {
  const drop = await failUpdates(key, when);
  try {
    return { result: await pay(t, { url: to, idempotencyKey: key }, deps()) };
  } catch (thrown) {
    return { thrown };
  } finally {
    await drop();
  }
}

describe.skipIf(!TEST_PG_URL)('given a paid call whose final write fails', () => {
  it('when the seller was paid and the conclusion cannot be stored, then the caller still gets the key to retry with', async () => {
    const t = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const { result, thrown } = await payWithFailedWrite(t, 'final-paid', "new.kind = 'paid'");
    expect(seen).toHaveLength(1);
    expect(thrown).toBeUndefined();
    expect(result?.structuredContent?.idempotencyKey).toBe('final-paid');
    expect(result?.structuredContent).toMatchObject({
      kind: 'paid',
      state: expect.stringMatching(/^(signed|settled)$/),
      payment: { nonce: seen[0].nonce.toLowerCase(), payTo: PAY_TO, amount: PRICE },
    });
    expect(result?.structuredContent?.response?.join()).toContain('the weather is fine');
  });

  it('given the conclusion, the lease release and the read back all fail, then the answer still names the payment the seller took', async () => {
    const t = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    readFails = true;
    const { result, thrown } = await payWithFailedWrite(
      t,
      'final-dark',
      "new.kind = 'paid' or new.lease_until is distinct from old.lease_until"
    );
    expect(thrown).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(result?.structuredContent).toMatchObject({
      kind: 'paid',
      payment: { nonce: seen[0].nonce.toLowerCase(), payTo: PAY_TO, amount: PRICE },
    });
    expect(result?.structuredContent?.summary).toContain(`Paid ${PRICE} base units to ${PAY_TO}`);
    expect(result?.structuredContent?.response?.join()).toContain('the weather is fine');
  });

  it('when the seller was paid and the conclusion cannot be stored, then the answer is not settled until a late check settles the row', async () => {
    const t = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const { result } = await payWithFailedWrite(t, 'final-late', "new.kind = 'paid'");
    expect(result?.structuredContent).toMatchObject({ kind: 'paid', state: 'signed' });
    expect(result?.structuredContent?.summary).toContain('Settlement is being confirmed');
    expect(lateTasks).toHaveLength(1);

    await lateTasks[0]();

    const [row] = await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'final-late'));
    expect(row).toMatchObject({ state: 'settled', kind: 'paid', amount: PRICE });
  });

  it('when the seller was paid and its transaction hash cannot be checked, then the caller gets the answer and the row concludes without the hash', async () => {
    const t = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    hashCheckFails = true;
    const result = await pay(t, { url, idempotencyKey: 'hash-dark' }, deps());
    expect(seen).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ kind: 'paid', idempotencyKey: 'hash-dark' });
    expect(result.structuredContent?.response?.join()).toContain('the weather is fine');
    const [row] = await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'hash-dark'));
    expect(row).toMatchObject({ kind: 'paid', txHash: null });
  });

  it('given a retry with the same key right after, then it does not answer in_progress for the whole lease', async () => {
    const t = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const { result: first } = await payWithFailedWrite(t, 'final-retry', "new.kind = 'paid'");
    const again = await pay(t, { url, idempotencyKey: 'final-retry' }, deps());
    expect(again.content[0].text).not.toContain('in_progress');
    expect(seen.map((s) => s.nonce)).toEqual([seen[0].nonce, seen[0].nonce]);
    expect(again.structuredContent).toMatchObject({
      kind: 'paid',
      paymentId: first?.structuredContent?.paymentId,
      payment: { nonce: seen[0].nonce.toLowerCase() },
    });
  });

  it('given a seller that refuses a used nonce, then the retry says the payment may have reached it, not that nothing was sent', async () => {
    const t = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 1_000_000n);
    const once = `http://${SELLER}/once`;
    await payWithFailedWrite(t, 'final-once', "new.kind = 'paid'", once);
    const again = await pay(t, { url: once, idempotencyKey: 'final-once' }, deps());
    expect(seen).toHaveLength(1);
    expect(again.structuredContent).toMatchObject({
      state: 'unknown',
      kind: 'failed',
      refusal: { code: 'settlement_rejected' },
      payment: { nonce: seen[0].nonce.toLowerCase() },
    });
    expect(again.structuredContent?.summary).toContain('A payment may have reached the seller');
    expect(again.structuredContent?.summary).not.toContain('Nothing was sent');
  });

  it('when the payment was refilled first, then the top-up and the sent proof stay on the row and the caller gets an answer', async () => {
    const t = await connected('1');
    balances.set(t.sessionAddress.toLowerCase(), 0n);
    const { thrown } = await payWithFailedWrite(t, 'final-refilled', 'new.kind is not null and old.kind is null');
    const [row] = await getDb().select().from(payments).where(eq(payments.idempotencyKey, 'final-refilled'));
    expect(refills).toHaveLength(1);
    expect(row.topUpAmount).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(row.nonce?.toLowerCase()).toBe(seen[0].nonce.toLowerCase());
    expect(thrown).toBeUndefined();
  });
});
