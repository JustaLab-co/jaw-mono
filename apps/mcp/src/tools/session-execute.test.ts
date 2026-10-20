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
  RpcRequestError,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { entryPoint08Abi, getUserOperationError } from 'viem/account-abstraction';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { revokeByGrant } from '@/connections/rows';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, sends, settings } from '@/db/schema';
import { lockWaiters, TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { recordGrant } from '@/grants/permission';
import { claim } from '@/payments/store';
import { x402Budget } from '@/grants/store';
import { reconcile } from '@/reconciler/run';
import { ANY_TARGET } from '@jaw.id/core';
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
  userOps: [] as { userOpHash: Hex; sender: Address; success: boolean; blockNumber: bigint; txHash?: Hex }[],
}));

const bridge = vi.hoisted(() => ({
  sent: [] as { to: string; value: string; data: string }[][],
  attempts: 0,
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
        bridge.attempts++;
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
  getLogs: async ({ args }: { args: { userOpHash?: Hex | Hex[]; sender?: Address } }) =>
    chain.userOps
      .filter((op) =>
        args.userOpHash
          ? [args.userOpHash].flat().includes(op.userOpHash)
          : op.sender.toLowerCase() === args.sender?.toLowerCase()
      )
      .map((op) => ({ args: op, blockNumber: op.blockNumber, transactionHash: op.txHash ?? TX })),
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
    attempts: 0,
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

async function withCustomGrant(perDay = 1_000_000n, end = NOW() + 86_400, target: Address = USDC) {
  const c = await connect();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const permissionId = `0x${randomBytes(32).toString('hex')}` as Hex;
  const permission = {
    account: t.account,
    spender: t.sessionAddress,
    start: NOW() - 60,
    end,
    salt: '0x01',
    calls: [{ target, selector: toFunctionSelector('transfer(address,uint256)') }],
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
const execute = (token: string, permissionId: string, calls: object[], idempotencyKey?: string) =>
  callTool(token, 'jaw_session_execute', { permissionId, calls, ...(idempotencyKey && { idempotencyKey }) });
const rowsOf = (connectionId: string) => getDb().select().from(sends).where(eq(sends.connectionId, connectionId));

const MANAGER_ERRORS = parseAbi(['error JustaPermissionManager_ExceededSpendLimit(uint256 value, uint256 allowance)']);
const overLimitRevert = encodeErrorResult({
  abi: MANAGER_ERRORS,
  errorName: 'JustaPermissionManager_ExceededSpendLimit',
  args: [1_500_000n, 1_000_000n],
});

const bundlerAnswered = (cause: Error) =>
  getUserOperationError(
    cause as never,
    {
      sender: BOB,
      nonce: 0n,
      callData: '0x',
      signature: '0x',
    } as never
  );
const bundlerSaid = (code: number, message: string) =>
  bundlerAnswered(
    new RpcRequestError({
      body: { method: 'eth_sendUserOperation' },
      error: { code, message },
      url: 'http://bundler.test',
    })
  );

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
      cause: new RpcRequestError({
        body: {},
        error: { code: -32521, message: 'execution reverted', data: overLimitRevert },
        url: 'http://bundler.test',
      }),
    });

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/^over-limit: .*Nothing was sent\.$/);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['released']);
  });

  it('given a grant on ANY_TARGET, then a manager error in a revert is not named, since the agent chose the contract that reverted', async () => {
    const { c, permissionId } = await withCustomGrant(1_000_000n, NOW() + 86_400, ANY_TARGET);
    bridge.fail = new Error('Could not size the ERC-20 paymaster approval', {
      cause: new RpcRequestError({
        body: {},
        error: { code: -32521, message: 'execution reverted', data: overLimitRevert },
        url: 'http://bundler.test',
      }),
    });

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/^Nothing was sent: the batch failed in simulation/);
  });

  it('given "already known" from the bundler, as a resend of an op it took answers, then the first reply says it may have been sent and the rows stay held', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerSaid(-32602, 'already known');

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);

    expect(result.content[0].text).toMatch(/may have been sent anyway.*jaw_session_history/);
    expect(result.content[0].text).not.toMatch(/Nothing was sent/);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
    bridge.fail = undefined;
    const next = await execute(c.access_token, permissionId, [transfer(CAROL, 600_000n)]);
    expect(next.content[0].text).toMatch(/^over-limit: .* has 400000 left this period/);
  });

  it('given an AA25 nonce error from the bundler, then the first reply says it may have been sent and the rows stay held', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerSaid(-32500, 'AA25 invalid account nonce');

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);

    expect(result.content[0].text).toMatch(/may have been sent anyway/);
    expect(result.content[0].text).not.toMatch(/Nothing was sent/);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
  });

  it('given a 5xx on the send and the bundler then up again, then the reply says it may have been sent and the same key never sends again', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerAnswered(new HttpRequestError({ url: 'http://bundler.test', status: 502 }));

    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)], 'pay-bob');
    bridge.fail = undefined;
    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)], 'pay-bob');

    expect(first.content[0].text).toMatch(/may have been sent anyway/);
    expect(retry.content[0].text).toMatch(/may have been sent anyway/);
    expect(bridge.attempts).toBe(1);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
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
    bridge.fail = bundlerAnswered(
      new HttpRequestError({ url: 'http://bundler.test', body: { callData: overLimitRevert } })
    );

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

  it('given an unconfirmed run that has since landed, when the next execute fits in what is left on chain, then it sends and the first row is landed', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    const userOpHash = first.structuredContent.userOpHash as Hex;
    chain.userOps.push({ userOpHash, sender: t.sessionAddress, success: true, blockNumber: 101n });
    chain.spent = 600_000n;
    bridge.outcome = 'landed';

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 300_000n)]);

    expect(second.structuredContent).toMatchObject({ status: 'landed' });
    expect(bridge.sent).toHaveLength(2);
    const rows = await rowsOf(t.connectionId);
    expect(rows.find((r) => r.callsId === userOpHash)).toMatchObject({ state: 'landed', txHash: TX });
  });

  it('given an unconfirmed run that has since reverted on chain, then its row is released and holds nothing against the next execute', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    const userOpHash = first.structuredContent.userOpHash as Hex;
    const reverted: Hex = `0x${'d'.repeat(64)}`;
    chain.userOps.push({ userOpHash, sender: t.sessionAddress, success: false, blockNumber: 101n, txHash: reverted });
    bridge.outcome = 'landed';

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 600_000n)]);

    expect(second.structuredContent).toMatchObject({ status: 'landed' });
    const rows = await rowsOf(t.connectionId);
    expect(rows.find((r) => r.callsId === userOpHash)).toMatchObject({ state: 'released', txHash: reverted });
  });

  it('given an unconfirmed run and logs that cannot be read, then its open row still counts and stays open', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    chain.userOps.push({
      userOpHash: first.structuredContent.userOpHash as Hex,
      sender: t.sessionAddress,
      success: true,
      blockNumber: 101n,
    });
    chain.spent = 600_000n;
    vi.spyOn(node, 'getLogs').mockRejectedValue(new Error('logs unavailable'));

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 300_000n)]);

    expect(second.content[0].text).toMatch(/^over-limit: .* has 0 left this period/);
    expect(bridge.sent).toHaveLength(1);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open' })]);
  });

  it('given a node behind the block where a run was logged landed, then the period read fails and nothing more is sent', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    chain.userOps.push({
      userOpHash: first.structuredContent.userOpHash as Hex,
      sender: t.sessionAddress,
      success: true,
      blockNumber: chain.head,
    });
    const answers = node.readContract as (args: unknown) => Promise<unknown>;
    // The node serving reads has not seen the run: its latest period is empty, and the logged block is ahead of it.
    node.readContract = (async (args: { functionName: string; blockNumber?: bigint }) => {
      if (args.blockNumber !== undefined) throw new Error('block not found');
      return args.functionName === 'getCurrentPeriod'
        ? { start: NOW() - 60, end: NOW() + 3_600, spend: 0n }
        : answers(args);
    }) as typeof node.readContract;
    bridge.outcome = 'landed';

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 600_000n)]);

    expect(second.content[0].text).toMatch(/could not be read from the chain/);
    expect(bridge.sent).toHaveLength(1);
  });

  it('given a log read that hangs, then the execute answers once the read times out and the open row still counts', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    chain.spent = 600_000n;
    vi.spyOn(node, 'getLogs').mockReturnValue(new Promise(() => {}));

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 300_000n)]);

    expect(second.content[0].text).toMatch(/^over-limit: .* has 0 left this period/);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open' })]);
  });

  it('given an unconfirmed run past its block window, then the next execute leaves it open for the reconciler', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    chain.userOps.push({
      userOpHash: first.structuredContent.userOpHash as Hex,
      sender: t.sessionAddress,
      success: true,
      blockNumber: 101n,
    });
    chain.spent = 600_000n;
    chain.head = 600n;

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 300_000n)]);

    expect(second.content[0].text).toMatch(/^over-limit: /);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open' })]);
  });

  it('given two unconfirmed runs and only one logged, then only that one settles and the other still counts', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 300_000n)]);
    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 300_000n)]);
    const logged = first.structuredContent.userOpHash as Hex;
    chain.userOps.push({ userOpHash: logged, sender: t.sessionAddress, success: true, blockNumber: 101n });
    chain.spent = 300_000n;
    bridge.outcome = 'landed';

    const third = await execute(c.access_token, permissionId, [transfer(BOB, 300_000n)]);

    expect(third.structuredContent).toMatchObject({ status: 'landed' });
    const rows = await rowsOf(t.connectionId);
    expect(rows.find((r) => r.callsId === logged)).toMatchObject({ state: 'landed' });
    expect(rows.find((r) => r.callsId === second.structuredContent.userOpHash)).toMatchObject({ state: 'open' });
  });

  it('given an execute recorded and not yet submitted, when its connection is revoked, then the end waits for the submit', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    const [{ grantId }] = await getDb()
      .select({ grantId: connections.grantId })
      .from(connections)
      .where(eq(connections.id, t.connectionId));
    const release = deferred();
    const reached = deferred();
    bridge.gate = release.promise;
    bridge.reached = reached.resolve;
    const statusOf = async () =>
      (await getDb().select().from(connections).where(eq(connections.id, t.connectionId)))[0].status;

    const sent = execute(c.access_token, permissionId, [transfer(BOB, 1n)]);
    await reached.promise;
    const ended = revokeByGrant(grantId as string, 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const whileInFlight = await statusOf();
    release.resolve();
    await Promise.all([sent, ended]);

    expect(whileInFlight).toBe('active');
    expect(await statusOf()).toBe('revoked');
    expect(bridge.sent).toHaveLength(1);
  });

  it('given a run whose receipt lands it after the log read, at a block past it, then it still counts and the next is over-limit', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    const answers = node.readContract as (args: unknown) => Promise<unknown>;
    // The pinned read sees the period as of the log read; only later blocks hold the run.
    node.readContract = (async (args: { functionName: string; blockNumber?: bigint }) => {
      if (args.functionName !== 'getCurrentPeriod') return answers(args);
      return { start: NOW() - 60, end: NOW() + 3_600, spend: args.blockNumber === undefined ? chain.spent : 0n };
    }) as typeof node.readContract;
    vi.spyOn(node, 'getLogs').mockImplementation(async () => {
      await getDb()
        .update(sends)
        .set({ state: 'landed', txHash: TX, finishedAt: new Date() })
        .where(eq(sends.connectionId, t.connectionId));
      chain.spent = 600_000n;
      return [];
    });
    bridge.outcome = 'landed';

    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 600_000n)]);

    expect(second.content[0].text).toMatch(/^over-limit: .* has 400000 left this period/);
    expect(bridge.sent).toHaveLength(1);
  });

  it('given rows an execute recorded and never submitted, then a revoke waits until their submit window passes', async () => {
    const { t, permissionId } = await withCustomGrant();
    const [{ grantId }] = await getDb()
      .select({ grantId: connections.grantId })
      .from(connections)
      .where(eq(connections.id, t.connectionId));
    const statusOf = async () =>
      (await getDb().select().from(connections).where(eq(connections.id, t.connectionId)))[0].status;
    vi.useFakeTimers({ toFake: ['Date'] });
    await getDb()
      .insert(sends)
      .values({
        id: 'send_crashed',
        connectionId: t.connectionId,
        idempotencyKey: 'crashed',
        requestHash: 'h',
        permissionId,
        chainId: t.chainId,
        sender: t.sessionAddress.toLowerCase(),
        amount: '1',
        periodStart: NOW(),
        fromBlock: 100n,
        leaseUntil: new Date(Date.now() + 10 * 60_000),
      });

    const ended = revokeByGrant(grantId as string, 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const withinWindow = await statusOf();
    // PGlite runs on the test's clock: past the window the run is the reconciler's.
    vi.setSystemTime(Date.now() + 2 * 60_000 + 1_000);
    await ended;

    expect(withinWindow).toBe('active');
    expect(await statusOf()).toBe('revoked');
  });

  it('given the connection ends while the batch is checked, then nothing is recorded or sent', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    // The head read right after fit is where an end lands between the checks and the record.
    vi.spyOn(node, 'getBlockNumber').mockImplementation(async () => {
      await getDb()
        .update(connections)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(connections.id, t.connectionId));
      return chain.head;
    });

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/connection has ended/);
    expect(bridge.attempts).toBe(0);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given an unconfirmed run that has since landed, then the session status counts its spend once in what is left', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)]);
    chain.userOps.push({
      userOpHash: first.structuredContent.userOpHash as Hex,
      sender: t.sessionAddress,
      success: true,
      blockNumber: 101n,
    });
    chain.spent = 600_000n;

    const status = await callTool(c.access_token, 'jaw_session_status', {});

    const grant = (status.structuredContent.grants as { permissionId: string; limits: { left: string }[] }[]).find(
      (g) => g.permissionId === permissionId
    );
    expect(grant?.limits[0].left).toBe('400000');
  });

  it('given an unconfirmed run that has since landed, when its idempotencyKey is sent again, then it replays the run landed and sends nothing', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)], 'late');
    const userOpHash = first.structuredContent.userOpHash as Hex;
    chain.userOps.push({ userOpHash, sender: t.sessionAddress, success: true, blockNumber: 101n });

    const again = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)], 'late');

    expect(again.structuredContent).toMatchObject({ status: 'landed', userOpHash, txHash: TX });
    expect(bridge.attempts).toBe(1);
  });

  it("given another connection's payment id as before, then the payments page is empty", async () => {
    const paid = { url: 'https://seller.test/paid', method: 'GET' as const, headers: {} };
    const mine = await withCustomGrant();
    await claim(
      { connectionId: mine.t.connectionId, payer: mine.t.sessionAddress, permissionId: mine.permissionId },
      'mine',
      paid
    );
    const other = await withCustomGrant();
    await claim(
      { connectionId: other.t.connectionId, payer: other.t.sessionAddress, permissionId: other.permissionId },
      'theirs',
      paid
    );
    const theirs = await callTool(other.c.access_token, 'jaw_session_history', {});
    const foreign = (theirs.structuredContent.payments as { paymentId: string }[])[0].paymentId;

    const page = await callTool(mine.c.access_token, 'jaw_session_history', { before: foreign });

    expect(page.structuredContent.payments).toEqual([]);
  });

  it('given more executes than a page, then executesNext pages through them with no overlap and no payments', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    for (const amount of [1n, 2n, 3n]) await execute(c.access_token, permissionId, [transfer(BOB, amount)]);
    const owner = { connectionId: t.connectionId, payer: t.sessionAddress, permissionId };
    await claim(owner, 'a-payment', { url: 'https://seller.test/paid', method: 'GET', headers: {} });

    const first = await callTool(c.access_token, 'jaw_session_history', { limit: 2 });
    const next = first.structuredContent.executesNext as string;
    const second = await callTool(c.access_token, 'jaw_session_history', { limit: 2, executesBefore: next });

    const amounts = (page: typeof first) =>
      (page.structuredContent.executes as { amount: string }[]).map((r) => r.amount);
    expect(amounts(first)).toEqual(['3', '2']);
    expect(amounts(second)).toEqual(['1']);
    expect(second.structuredContent).not.toHaveProperty('executesNext');
    expect(first.structuredContent.payments).toHaveLength(1);
    expect(second.structuredContent.payments).toEqual([]);
    const paymentsOnly = await callTool(c.access_token, 'jaw_session_history', { before: 'pay_none' });
    expect(paymentsOnly.structuredContent.executes).toEqual([]);
  });

  it("given another connection's send id as executesBefore, then the page is empty", async () => {
    const other = await withCustomGrant();
    await execute(other.c.access_token, other.permissionId, [transfer(BOB, 1n)]);
    const mine = await withCustomGrant();
    await execute(mine.c.access_token, mine.permissionId, [transfer(BOB, 1n)]);
    const [row] = await rowsOf(mine.t.connectionId);

    const page = await callTool(other.c.access_token, 'jaw_session_history', { executesBefore: row.id });

    expect(page.structuredContent.executes).toEqual([]);
  });

  it('given the same idempotencyKey and input after a run landed, then it returns that run and sends nothing', async () => {
    const { c, permissionId } = await withCustomGrant();

    const first = await execute(c.access_token, permissionId, [transfer(BOB, 250_000n)], 'pay-bob');
    const again = await execute(c.access_token, permissionId, [transfer(BOB, 250_000n)], 'pay-bob');

    expect(first.structuredContent).toMatchObject({ status: 'landed', idempotencyKey: 'pay-bob' });
    expect(again.structuredContent).toEqual(first.structuredContent);
    expect(bridge.attempts).toBe(1);
  });

  it('given the same idempotencyKey with other calls, then it is an idempotency_conflict and nothing is sent', async () => {
    const { c, permissionId } = await withCustomGrant();
    await execute(c.access_token, permissionId, [transfer(BOB, 250_000n)], 'pay-bob');

    const other = await execute(c.access_token, permissionId, [transfer(CAROL, 250_000n)], 'pay-bob');

    expect(other.isError).toBe(true);
    expect(other.content[0].text).toMatch(/^idempotency_conflict: .*Nothing was sent\./);
    expect(bridge.attempts).toBe(1);
  });

  it('given a retry with the same idempotencyKey after the answer was lost, then it does not send again', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerAnswered(new HttpRequestError({ url: 'http://bundler.test' }));
    await execute(c.access_token, permissionId, [transfer(BOB, 100_000n)], 'pay-bob');
    bridge.fail = undefined;

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 100_000n)], 'pay-bob');

    expect(retry.content[0].text).toMatch(/may have been sent/);
    expect(bridge.attempts).toBe(1);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
  });

  it('given the same idempotencyKey after the bundler answered "already known", then it says it may have been sent and does not send again', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerSaid(-32602, 'already known');
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    bridge.fail = undefined;

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.content[0].text).toMatch(/may have been sent anyway/);
    expect(bridge.attempts).toBe(1);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
  });

  it('given the same idempotencyKey after a failure before the userOp existed, then it still does not send again', async () => {
    const { c, permissionId } = await withCustomGrant();
    bridge.fail = new Error('the permission store did not answer');
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    bridge.fail = undefined;

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.content[0].text).toMatch(/new idempotencyKey/);
    expect(bridge.attempts).toBe(1);
  });

  it('given the same idempotencyKey after the userOp reverted on chain, then it replays the revert with its transaction', async () => {
    const { c, permissionId } = await withCustomGrant();
    bridge.outcome = { logs: [] };
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.structuredContent).toMatchObject({ status: 'reverted', txHash: TX });
    expect(bridge.attempts).toBe(1);
  });

  it('given a run the reconciler released for not being seen in its window, then its key does not replay it as moved nothing', async () => {
    const { c, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    chain.head = 100n + 451n;
    vi.setSystemTime(Date.now() + 1_000);
    await reconcile({ publicClient: () => node as unknown as PublicClient });

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.content[0].text).toMatch(/not seen on chain in time.*may still land/);
    expect(retry.content[0].text).not.toMatch(/moved nothing/);
    expect(bridge.attempts).toBe(1);
  });

  it('given two calls with one idempotencyKey at once, then one sends and the other returns its outcome', async () => {
    const { c, permissionId } = await withCustomGrant();
    const release = deferred();
    const reached = deferred();
    bridge.gate = release.promise;
    bridge.reached = reached.resolve;

    const first = execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    await reached.promise;
    const second = execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    release.resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(a.structuredContent).toMatchObject({ status: 'landed' });
    expect(b.structuredContent?.userOpHash).toBe(a.structuredContent.userOpHash);
    expect(bridge.attempts).toBe(1);
  });

  it('given two runs from the same sender that land, then the reconciler settles each row to its own receipt', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 100_000n)]);
    const second = await execute(c.access_token, permissionId, [transfer(CAROL, 200_000n)]);
    const own = (r: typeof first, txHash: Hex) => ({
      userOpHash: r.structuredContent.userOpHash as Hex,
      sender: t.sessionAddress,
      success: true,
      blockNumber: 101n,
      txHash,
    });
    const TX2: Hex = `0x${'d'.repeat(64)}`;
    chain.userOps.push(own(second, TX2), own(first, TX));
    chain.head = 120n;
    vi.setSystemTime(Date.now() + 1_000);

    await reconcile({ publicClient: () => node as unknown as PublicClient });

    const rows = await rowsOf(t.connectionId);
    expect(rows.find((r) => r.amount === '100000')).toMatchObject({ state: 'landed', txHash: TX });
    expect(rows.find((r) => r.amount === '200000')).toMatchObject({ state: 'landed', txHash: TX2 });
  });

  it('given a lost run with no userOp hash, then the reconciler never lands it on another operation of the sender', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerAnswered(new HttpRequestError({ url: 'http://bundler.test' }));
    await execute(c.access_token, permissionId, [transfer(BOB, 100_000n)]);
    bridge.fail = undefined;
    const other: Hex = `0x${'d'.repeat(64)}`;
    chain.userOps.push({
      userOpHash: `0x${'9'.repeat(64)}`,
      sender: t.sessionAddress,
      success: true,
      blockNumber: 101n,
      txHash: other,
    });
    chain.head = 120n;

    await reconcile({ publicClient: () => node as unknown as PublicClient });
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open', txHash: null })]);

    chain.head = 100n + 451n;
    await getDb()
      .update(sends)
      .set({ leaseUntil: new Date(0) })
      .where(eq(sends.connectionId, t.connectionId));
    await reconcile({ publicClient: () => node as unknown as PublicClient });
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'released', txHash: null })]);
  });

  it('given a row found by its sender, when only another operation of the sender reverted, then the reconciler leaves it open', async () => {
    const { t, permissionId } = await withCustomGrant();
    await getDb()
      .insert(sends)
      .values({
        id: 'send_by_sender',
        connectionId: t.connectionId,
        permissionId,
        chainId: t.chainId,
        sender: t.sessionAddress.toLowerCase(),
        amount: '1',
        periodStart: NOW(),
        fromBlock: 100n,
        leaseUntil: new Date(0),
      });
    chain.userOps.push({
      userOpHash: `0x${'9'.repeat(64)}`,
      sender: t.sessionAddress,
      success: false,
      blockNumber: 101n,
    });
    chain.head = 120n;

    await reconcile({ publicClient: () => node as unknown as PublicClient });

    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open', txHash: null })]);
  });
});

describe.skipIf(!TEST_PG_URL)('jaw_session_execute across replicas', () => {
  it('given one idempotencyKey on two replicas, when the second waits on the float lock while the first sends, then it returns the first run and sends nothing', async () => {
    const { t, permissionId } = await withCustomGrant();
    const here = await import('./session-execute');
    vi.resetModules();
    const there = await import('./session-execute');
    const release = deferred();
    const reached = deferred();
    bridge.gate = release.promise;
    bridge.reached = reached.resolve;
    const input = { permissionId, calls: [transfer(BOB, 1n)], idempotencyKey: 'pay-bob' };

    const first = here.sessionExecute(t, input);
    await reached.promise;
    const second = there.sessionExecute(t, input);
    while ((await lockWaiters(t.connectionId)) === 0) await new Promise((resolve) => setImmediate(resolve));
    release.resolve();

    const [a, b] = await Promise.all([first, second]);
    const userOpHash = `0x${'1'.padStart(64, '0')}`;
    expect(a).toMatchObject({ structuredContent: { status: 'landed', userOpHash } });
    expect(b).toMatchObject({ structuredContent: { userOpHash } });
    expect(bridge.attempts).toBe(1);
  });

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
