import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  HttpRequestError,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { entryPoint08Abi } from 'viem/account-abstraction';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { sends, settings } from '@/db/schema';
import { lockWaiters, TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { recordGrant } from '@/grants/permission';
import { x402Budget } from '@/grants/store';
import { reconcile } from '@/reconciler/run';
import { RECEIPT_MS } from './session-execute';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BOB: Address = '0x2222222222222222222222222222222222222222';
const CAROL: Address = '0x3333333333333333333333333333333333333333';
const TX: Hex = `0x${'c'.repeat(64)}`;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const chain = vi.hoisted(() => ({
  spent: 0n,
  revoked: false,
  head: 100n,
  userOps: [] as { userOpHash: Hex; sender: Address; success: boolean; blockNumber: bigint }[],
}));

const bridge = vi.hoisted(() => ({
  sent: [] as { to: string; value: string; data: string }[][],
  outcome: 'landed' as 'landed' | 'pending' | { logs: { data: string; topics: string[] }[] },
  fail: undefined as Error | undefined,
  gate: undefined as Promise<void> | undefined,
  reached: undefined as (() => void) | undefined,
  receiptGate: undefined as Promise<void> | undefined,
}));

vi.mock('@/adapters/session-host', async (original) => ({
  ...(await original<object>()),
  sessionBridge: () => ({
    request: async (method: string, params: unknown) => {
      if (method === 'wallet_sendCalls') {
        bridge.reached?.();
        if (bridge.gate) await bridge.gate;
        if (bridge.fail) throw bridge.fail;
        const calls = (params as [{ calls: { to: string; value: string; data: string }[] }])[0].calls;
        bridge.sent.push(calls);
        return { id: `0x${bridge.sent.length.toString(16).padStart(64, '0')}` };
      }
      if (bridge.receiptGate) await bridge.receiptGate;
      const id = params as Hex;
      const calls = bridge.sent[Number(BigInt(id)) - 1];
      if (bridge.outcome === 'pending') {
        vi.setSystemTime(Date.now() + RECEIPT_MS + 1_000);
        return undefined;
      }
      if (bridge.outcome !== 'landed') {
        return {
          status: 500,
          receipts: [{ transactionHash: TX, logs: bridge.outcome.logs }],
        };
      }
      if (!chain.userOps.some((op) => op.userOpHash === id)) {
        for (const c of calls)
          chain.spent += decodeFunctionData({ abi: erc20Abi, data: c.data as Hex }).args[1] as bigint;
        chain.userOps.push({ userOpHash: id, sender: BOB, success: true, blockNumber: chain.head });
      }
      return { status: 200, receipts: [{ transactionHash: TX, logs: [] }] };
    },
  }),
}));

const node = vi.hoisted(() => ({
  getBlockNumber: async () => chain.head,
  getLogs: async ({ args }: { args: { userOpHash?: Hex } }) =>
    chain.userOps
      .filter((op) => op.userOpHash === args.userOpHash)
      .map((op) => ({ args: op, blockNumber: op.blockNumber, transactionHash: TX })),
  readContract: async () => undefined as unknown,
}));
vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () => node as unknown as PublicClient,
}));

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterEach(async () => {
  Object.assign(chain, { spent: 0n, revoked: false, head: 100n, userOps: [] });
  Object.assign(bridge, {
    sent: [],
    outcome: 'landed',
    fail: undefined,
    gate: undefined,
    reached: undefined,
    receiptGate: undefined,
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  await getDb().delete(settings);
});

const NOW = () => Math.floor(Date.now() / 1000);

async function withCustomGrant(perDay = 1_000_000n, end = NOW() + 86_400) {
  const c = await connect();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const permissionId = `0x${randomBytes(32).toString('hex')}` as Hex;
  const permission = {
    account: t.account,
    spender: t.sessionAddress,
    start: NOW() - 60,
    end,
    salt: '0x01',
    calls: [{ target: USDC, selector: toFunctionSelector('transfer(address,uint256)') }],
    spends: [{ token: USDC, allowance: perDay.toString(), unit: 'day', multiplier: 1 }],
  };
  await getDb().transaction((tx) =>
    recordGrant(tx, t.connectionId, {
      permissionId,
      kind: 'custom',
      chainId: t.chainId,
      account: t.account,
      spender: t.sessionAddress,
      token: USDC,
      allowance: perDay.toString(),
      period: 'day',
      permission,
      expiresAt: new Date(end * 1000),
    })
  );
  node.readContract = (async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getHash') return permissionId;
    if (functionName === 'isApproved') return true;
    if (functionName === 'isRevoked') return chain.revoked;
    if (functionName === 'getCurrentPeriod') return { start: NOW() - 60, end: NOW() + 3_600, spend: chain.spent };
    throw new Error(`this node does not answer ${functionName}`);
  }) as typeof node.readContract;
  return { c, t, permissionId };
}

const transfer = (to: Address, amount: bigint) => ({
  to: USDC,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
});
const execute = (token: string, permissionId: string, calls: object[]) =>
  callTool(token, 'jaw_session_execute', { permissionId, calls });
const rowsOf = (connectionId: string) => getDb().select().from(sends).where(eq(sends.connectionId, connectionId));

const MANAGER_ERRORS = parseAbi(['error JustaPermissionManager_ExceededSpendLimit(uint256 value, uint256 allowance)']);
const overLimitRevert = encodeErrorResult({
  abi: MANAGER_ERRORS,
  errorName: 'JustaPermissionManager_ExceededSpendLimit',
  args: [1_500_000n, 1_000_000n],
});

describe('jaw_session_execute', () => {
  it('sends a transfer the custom grant allows with no owner prompt, records it landed, and history lists it', async () => {
    const { c, t, permissionId } = await withCustomGrant();

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 250_000n)]);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'landed', txHash: TX });
    expect(bridge.sent).toEqual([[{ ...transfer(BOB, 250_000n), value: '0x0' }]]);
    const [row] = await rowsOf(t.connectionId);
    expect(row).toMatchObject({ state: 'landed', token: USDC.toLowerCase(), amount: '250000', txHash: TX });
    const history = await callTool(c.access_token, 'jaw_session_history', {});
    expect(history.structuredContent.executes).toEqual([
      expect.objectContaining({
        permissionId,
        state: 'landed',
        amount: '250000',
        userOpHash: result.structuredContent.userOpHash,
        txHash: TX,
      }),
    ]);
  });

  it('refuses a call to another address as call-not-allowed and sends no userOp', async () => {
    const { c, t, permissionId } = await withCustomGrant();

    const result = await execute(c.access_token, permissionId, [{ ...transfer(BOB, 1n), to: CAROL }]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^call-not-allowed: /);
    expect(bridge.sent).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('refuses a transfer past what the day has left as over-limit before sending', async () => {
    const { c, permissionId } = await withCustomGrant();
    chain.spent = 900_000n;

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 200_000n)]);

    expect(result.content[0].text).toMatch(/^over-limit: .* has 100000 left this period/);
    expect(bridge.sent).toEqual([]);
  });

  it('refuses a grant past its end as expired', async () => {
    const { c, permissionId } = await withCustomGrant(1_000_000n, NOW() - 1);
    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);
    expect(result.content[0].text).toMatch(/^expired: /);
    expect(bridge.sent).toEqual([]);
  });

  it('refuses an unknown permission id as no-grant', async () => {
    const { c } = await withCustomGrant();
    const result = await execute(c.access_token, `0x${'e'.repeat(64)}`, [transfer(BOB, 1n)]);
    expect(result.content[0].text).toMatch(/^no-grant: /);
    expect(bridge.sent).toEqual([]);
  });

  it('refuses a grant revoked on chain as no-grant', async () => {
    const { c, permissionId } = await withCustomGrant();
    chain.revoked = true;
    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);
    expect(result.content[0].text).toMatch(/^no-grant: /);
    expect(bridge.sent).toEqual([]);
  });

  it('refuses the x402 budget by name: it pays x402 only', async () => {
    const { c, t } = await withCustomGrant();
    const budget = (await x402Budget(t.connectionId))?.permissionId as string;

    const result = await execute(c.access_token, budget, [transfer(BOB, 1n)]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^no-grant: .*x402 budget, which pays x402 services only/);
    expect(bridge.sent).toEqual([]);
  });

  it('given payments paused on the server, then it refuses and sends nothing', async () => {
    const { c, permissionId } = await withCustomGrant();
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });
    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);
    expect(result.isError).toBe(true);
    expect(bridge.sent).toEqual([]);
  });

  it('names an ExceededSpendLimit the bundler reports after fit passed as over-limit, and releases the rows', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = new Error('Could not size the ERC-20 paymaster approval', {
      cause: { name: 'RpcRequestError', details: `execution reverted: ${overLimitRevert}` },
    });

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/^over-limit: .*Nothing was sent\.$/);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['released']);
  });

  it('names an over-limit revert the EntryPoint logged for a userOp that reverted on chain', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    const topics = encodeEventTopics({
      abi: entryPoint08Abi,
      eventName: 'UserOperationRevertReason',
      args: { userOpHash: `0x${'1'.repeat(64)}`, sender: t.sessionAddress },
    }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, overLimitRevert]);
    bridge.outcome = { logs: [{ topics, data }] };

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^over-limit: .*did not succeed on chain/);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['released']);
  });

  it('given a send whose answer was lost in transit, then it says it may have been sent and keeps the spend held', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = new Error('send failed', {
      cause: new HttpRequestError({ url: 'http://bundler.test', body: { callData: overLimitRevert } }),
    });

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);

    expect(result.content[0].text).toMatch(/may have been sent anyway/);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open', amount: '600000' })]);
    bridge.fail = undefined;
    const next = await execute(c.access_token, permissionId, [transfer(CAROL, 600_000n)]);
    expect(next.content[0].text).toMatch(/^over-limit: /);
  });

  it('given a failure before the bundler took the batch, then nothing was sent and the rows are released', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = new Error('the permission store did not answer');

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/^Nothing was sent: /);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['released']);
  });

  it('refuses a connection without x402:pay before reading any grant', async () => {
    const c = await connect(undefined, { scope: 'wallet:read' });
    const result = await execute(c.access_token, `0x${'e'.repeat(64)}`, [transfer(BOB, 1n)]);
    expect(result.content[0].text).toMatch(/x402:pay/);
  });

  it('given two executes that together pass the limit, when the second comes while the first is sending, then the first lands and the second is over-limit', async () => {
    const { c, permissionId } = await withCustomGrant();
    const release = deferred();
    const reached = deferred();
    bridge.gate = release.promise;
    bridge.reached = reached.resolve;

    const first = execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    await reached.promise;
    const landing = deferred();
    bridge.receiptGate = landing.promise;
    const second = execute(c.access_token, permissionId, [transfer(CAROL, 600_000n)]);
    release.resolve();

    // The first waits on its receipt, outside the lock: only its open row stands for its spend.
    const b = await second;
    landing.resolve();
    const a = await first;
    expect(a).toMatchObject({ structuredContent: { status: 'landed' } });
    expect(b.content[0].text).toMatch(/^over-limit: .* has 400000 left this period/);
    expect(bridge.sent).toHaveLength(1);
  });

  it('given an execute left unconfirmed, then its open row holds its spend against the next, and the reconciler settles it when it lands', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });

    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    expect(first.structuredContent).toMatchObject({ status: 'unconfirmed', txHash: null });

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 600_000n)]);
    expect(second.content[0].text).toMatch(/^over-limit: .* has 400000 left this period/);
    expect(bridge.sent).toHaveLength(1);

    const userOpHash = first.structuredContent.userOpHash as Hex;
    chain.userOps.push({ userOpHash, sender: t.sessionAddress, success: true, blockNumber: 101n });
    chain.head = 120n;
    // PGlite runs on the test's clock, which stopped where the row was handed to the reconciler.
    vi.setSystemTime(Date.now() + 1_000);
    await reconcile({ publicClient: () => node as unknown as PublicClient });
    expect(await rowsOf(t.connectionId)).toEqual([
      expect.objectContaining({ state: 'landed', txHash: TX, callsId: userOpHash }),
    ]);
  });
});

describe.skipIf(!TEST_PG_URL)('jaw_session_execute across replicas', () => {
  it('given the second execute on another replica, when it waits on the float lock while the first sends, then it reads the landed spend and is over-limit', async () => {
    const { t, permissionId } = await withCustomGrant();
    const here = await import('./session-execute');
    vi.resetModules();
    const there = await import('./session-execute');
    const release = deferred();
    const reached = deferred();
    bridge.gate = release.promise;
    bridge.reached = reached.resolve;

    const first = here.sessionExecute(t, { permissionId, calls: [transfer(BOB, 600_000n)] });
    await reached.promise;
    const second = there.sessionExecute(t, { permissionId, calls: [transfer(CAROL, 600_000n)] });
    while ((await lockWaiters(t.connectionId)) === 0) await new Promise((resolve) => setImmediate(resolve));
    const landing = deferred();
    bridge.receiptGate = landing.promise;
    release.resolve();

    const b = await second;
    landing.resolve();
    const a = await first;
    expect(a).toMatchObject({ structuredContent: { status: 'landed' } });
    expect(b.content[0].text).toMatch(/^over-limit: .* has 400000 left this period/);
    expect(bridge.sent).toHaveLength(1);
  });
});
