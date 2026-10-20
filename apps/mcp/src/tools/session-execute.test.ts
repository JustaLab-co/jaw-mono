import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
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
import { entryPoint08Abi, entryPoint08Address, getUserOperationError } from 'viem/account-abstraction';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, sends, settings } from '@/db/schema';
import { lockWaiters, TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { recordGrant } from '@/grants/permission';
import { x402Budget } from '@/grants/store';
import * as sendStore from '@/payments/sends';
import { reconcile } from '@/reconciler/run';
import { ANY_TARGET } from '@jaw.id/core';
import { LOCK_WAIT_MS } from '@/payments/float-lock';
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

type Wire = { to: string; value: string; data: string };
const bridge = vi.hoisted(() => ({
  signed: [] as Wire[][],
  sent: [] as Wire[][],
  attempts: 0,
  outcome: 'landed' as 'landed' | 'pending' | { logs: { address: string; data: string; topics: string[] }[] },
  failBeforeSigning: undefined as Error | undefined,
  beforeSigned: undefined as (() => Promise<void>) | undefined,
  answeredHash: undefined as Hex | undefined,
  fail: undefined as Error | undefined,
  gate: undefined as Promise<void> | undefined,
  reached: undefined as (() => void) | undefined,
  receiptGate: undefined as Promise<void> | undefined,
}));

const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

async function sendCalls(calls: Wire[], onSigned: (hash: Hex) => Promise<void>) {
  bridge.attempts++;
  bridge.reached?.();
  if (bridge.gate) await bridge.gate;
  if (bridge.failBeforeSigning) throw bridge.failBeforeSigning;
  bridge.signed.push(calls);
  const id = hashOf(bridge.signed.length);
  await bridge.beforeSigned?.();
  await onSigned(id);
  if (bridge.fail) throw bridge.fail;
  bridge.sent.push(calls);
  return { id: bridge.answeredHash ?? id, chainId: 84532 };
}

vi.mock('@/adapters/session-host', async (original) => ({
  ...(await original<object>()),
  sessionBridge: () => ({
    request: async (method: string, params: unknown, onSigned: (hash: Hex) => Promise<void>) => {
      if (method === 'wallet_sendCalls') return sendCalls((params as [{ calls: Wire[] }])[0].calls, onSigned);
      if (bridge.receiptGate) await bridge.receiptGate;
      const id = params as Hex;
      const calls = bridge.signed[Number(BigInt(id)) - 1];
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
  getLogs: async ({ args }: { args: { userOpHash?: Hex; sender?: Address } }) =>
    chain.userOps
      .filter((op) =>
        args.userOpHash ? op.userOpHash === args.userOpHash : op.sender.toLowerCase() === args.sender?.toLowerCase()
      )
      .map((op) => ({ args: op, blockNumber: op.blockNumber, transactionHash: op.txHash ?? TX })),
  readContract: async () => undefined as unknown,
}));
const writes = vi.hoisted(() => ({ failHash: false }));
vi.mock('@/payments/sends', async (original) => {
  const sends = await original<typeof import('@/payments/sends')>();
  return {
    ...sends,
    noteCallsId: async (...args: Parameters<typeof sends.noteCallsId>) => {
      if (writes.failHash) throw new Error('the database did not answer');
      return sends.noteCallsId(...args);
    },
  };
});

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () => node as unknown as PublicClient,
}));

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterEach(async () => {
  Object.assign(chain, { spent: 0n, revoked: false, head: 100n, userOps: [] });
  writes.failHash = false;
  Object.assign(bridge, {
    signed: [],
    sent: [],
    attempts: 0,
    outcome: 'landed',
    failBeforeSigning: undefined,
    beforeSigned: undefined,
    answeredHash: undefined,
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
    if (functionName === 'getCurrentPeriod') {
      return { start: permission.start, end: permission.start + 86_400, spend: chain.spent };
    }
    throw new Error(`this node does not answer ${functionName}`);
  }) as typeof node.readContract;
  return { c, t, permissionId };
}

const clients = { publicClient: () => node as unknown as PublicClient };
const noReceipt = async () => null;

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
    bridge.failBeforeSigning = new Error('Could not size the ERC-20 paymaster approval', {
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
    bridge.failBeforeSigning = new Error('Could not size the ERC-20 paymaster approval', {
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

  it('given a 5xx on the send and the bundler then up again, then the reply says it may have been sent as its userOp and the same key never sends again', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerAnswered(new HttpRequestError({ url: 'http://bundler.test', status: 502 }));

    const first = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)], 'pay-bob');
    bridge.fail = undefined;
    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 600_000n)], 'pay-bob');

    expect(first.content[0].text).toMatch(`may have been sent anyway as userOp ${hashOf(1)}`);
    expect(retry.structuredContent).toMatchObject({ status: 'unconfirmed', userOpHash: hashOf(1) });
    expect(bridge.attempts).toBe(1);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
  });

  const revertLog = (userOpHash: Hex, sender: Address) => ({
    address: entryPoint08Address,
    topics: encodeEventTopics({
      abi: entryPoint08Abi,
      eventName: 'UserOperationRevertReason',
      args: { userOpHash, sender },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, overLimitRevert]),
  });
  const FIRST_OP: Hex = `0x${'1'.padStart(64, '0')}`;

  it('names an over-limit revert the EntryPoint logged for a userOp that reverted on chain', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = { logs: [revertLog(FIRST_OP, t.sessionAddress)] };

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^over-limit: .*did not succeed on chain/);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['released']);
  });

  it('given a reverted userOp bundled with another account whose userOp was refused, then it names no refusal', async () => {
    const { c, permissionId } = await withCustomGrant();
    bridge.outcome = { logs: [revertLog(`0x${'2'.repeat(64)}`, CAROL)] };

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/over-limit/);
    expect(result.structuredContent).toMatchObject({ status: 'reverted', userOpHash: FIRST_OP });
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
    bridge.failBeforeSigning = new Error('the permission store did not answer');

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

  it('given a retry with the same idempotencyKey after the answer was lost, then it follows the signed userOp and does not send again', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerAnswered(new HttpRequestError({ url: 'http://bundler.test' }));
    await execute(c.access_token, permissionId, [transfer(BOB, 100_000n)], 'pay-bob');
    bridge.fail = undefined;

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 100_000n)], 'pay-bob');

    expect(retry.structuredContent).toMatchObject({ status: 'unconfirmed', userOpHash: hashOf(1) });
    expect(bridge.attempts).toBe(1);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
  });

  it('given the same idempotencyKey after the bundler answered "already known", then it follows the signed userOp and does not send again', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerSaid(-32602, 'already known');
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    bridge.fail = undefined;

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.structuredContent).toMatchObject({ status: 'unconfirmed', userOpHash: hashOf(1) });
    expect(bridge.attempts).toBe(1);
    expect((await rowsOf(t.connectionId)).map((r) => r.state)).toEqual(['open']);
  });

  it('given the same idempotencyKey after a failure before the userOp existed, then it still does not send again', async () => {
    const { c, permissionId } = await withCustomGrant();
    bridge.failBeforeSigning = new Error('the permission store did not answer');
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    bridge.failBeforeSigning = undefined;

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.content[0].text).toMatch(/new idempotencyKey/);
    expect(bridge.attempts).toBe(1);
  });

  it('given a run left open before its userOp was signed, then its key says nothing was sent and does not send again', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.failBeforeSigning = new Error('the process stopped');
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    bridge.failBeforeSigning = undefined;
    await getDb().update(sends).set({ state: 'open', finishedAt: null }).where(eq(sends.connectionId, t.connectionId));

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.content[0].text).toMatch(/^This key's run sent nothing/);
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

  it('given the userOp hash write after the send failed, when the userOp reverts, then its key still replays the revert', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = { logs: [] };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const noteCallsId = sendStore.noteCallsId;
    const write = vi
      .spyOn(sendStore, 'noteCallsId')
      .mockImplementationOnce(noteCallsId)
      .mockRejectedValueOnce(new Error('db blip'));
    const first = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(write).toHaveBeenCalledTimes(2);
    const userOpHash = first.structuredContent.userOpHash;
    expect(retry.structuredContent).toMatchObject({ status: 'reverted', userOpHash, txHash: TX });
    expect(await rowsOf(t.connectionId)).toEqual([
      expect.objectContaining({ state: 'released', callsId: userOpHash, txHash: TX }),
    ]);
    expect(bridge.attempts).toBe(1);
  });

  it('given a run the reconciler released for not being seen in its window, then its key does not replay it as moved nothing', async () => {
    const { c, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    chain.head = 100n + 451n;
    vi.setSystemTime(Date.now() + 1_000);
    await reconcile(clients, new Date(), noReceipt, async () => false);

    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(retry.content[0].text).toMatch(/not seen on chain in time.*may still land/);
    expect(retry.content[0].text).not.toMatch(/moved nothing/);
    expect(bridge.attempts).toBe(1);
  });

  it('given a run past its log window that the bundler still holds, then the reconciler keeps its spend held', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);
    chain.head = 100n + 451n;
    vi.setSystemTime(Date.now() + 1_000);
    const asked: string[] = [];

    await reconcile(clients, new Date(), noReceipt, async (_chainId, callsId) => {
      asked.push(callsId);
      return true;
    });

    expect(asked).toEqual([hashOf(1)]);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open', callsId: hashOf(1) })]);

    chain.head = 100n + 901n;
    await getDb()
      .update(sends)
      .set({ leaseUntil: new Date(0) })
      .where(eq(sends.connectionId, t.connectionId));
    await reconcile(clients, new Date(), noReceipt, async () => true);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'released' })]);
  });

  it('given a run that landed after its log window, then the reconciler settles it from the bundler receipt', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);
    chain.head = 100n + 451n;
    vi.setSystemTime(Date.now() + 1_000);
    const late: Hex = `0x${'e'.repeat(64)}`;

    await reconcile(
      clients,
      new Date(),
      async (_chainId, callsId) => (callsId === hashOf(1) ? { success: true, txHash: late } : null),
      async () => false
    );

    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'landed', txHash: late })]);
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

  it('given a send whose answer was lost, then its rows keep the signed userOp hash and the reconciler lands them on that op alone', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.fail = bundlerAnswered(new HttpRequestError({ url: 'http://bundler.test' }));
    await execute(c.access_token, permissionId, [transfer(BOB, 100_000n)]);
    bridge.fail = undefined;
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open', callsId: hashOf(1) })]);
    const other: Hex = `0x${'d'.repeat(64)}`;
    const own = { sender: t.sessionAddress, success: true, blockNumber: 101n };
    chain.userOps.push({ ...own, userOpHash: `0x${'9'.repeat(64)}`, txHash: other });
    chain.head = 120n;

    await reconcile({ publicClient: () => node as unknown as PublicClient });
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'open', txHash: null })]);

    chain.userOps.push({ ...own, userOpHash: hashOf(1), txHash: TX });
    await getDb()
      .update(sends)
      .set({ leaseUntil: new Date(0) })
      .where(eq(sends.connectionId, t.connectionId));
    await reconcile({ publicClient: () => node as unknown as PublicClient });
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'landed', txHash: TX })]);
  });

  it('given a bundler error before the userOp was signed, then nothing was sent and the rows are released', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.failBeforeSigning = bundlerAnswered(new HttpRequestError({ url: 'http://bundler.test', status: 502 }));

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/^Nothing was sent: /);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'released', callsId: null })]);
  });

  it('given the bundler refuses the signed userOp in simulation, then nothing was sent and its key replays that, not a hash that may land', async () => {
    const { c, t, permissionId } = await withCustomGrant(1_000_000n, NOW() + 86_400, ANY_TARGET);
    bridge.fail = bundlerSaid(-32521, 'execution reverted');

    const first = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');
    bridge.fail = undefined;
    const retry = await execute(c.access_token, permissionId, [transfer(BOB, 1n)], 'pay-bob');

    expect(first.content[0].text).toMatch(/^Nothing was sent: /);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'released', callsId: null })]);
    expect(retry.content[0].text).toMatch(/^This key's run sent nothing/);
    expect(bridge.attempts).toBe(1);
  });

  it('given the bundler answers with another hash than the one signed, then it is logged and the rows keep the bundler hash', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.answeredHash = `0x${'a'.repeat(64)}`;
    bridge.outcome = 'pending';
    vi.useFakeTimers({ toFake: ['Date'] });
    const logged = vi.spyOn(console, 'log');

    await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(logged.mock.calls.flat().join('\n')).toContain('bundler returned another userOp hash');
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ callsId: `0x${'a'.repeat(64)}` })]);
  });

  it('given the signed userOp hash cannot be recorded, then it is never sent and the rows are released', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    writes.failHash = true;

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/^Nothing was sent: /);
    expect(bridge.sent).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'released', callsId: null })]);
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

  it('given its rows were settled while the userOp was being signed, then the hash has nowhere to go and nothing is sent', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.beforeSigned = async () => {
      await getDb()
        .update(sends)
        .set({ state: 'released', finishedAt: new Date() })
        .where(eq(sends.connectionId, t.connectionId));
    };

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/^Nothing was sent: /);
    expect(bridge.sent).toEqual([]);
  });

  it('given the hash write waits past its lock timeout, then nothing is sent and the reply says the turn was lost', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    const release = deferred();
    const locked = deferred();
    let holding: Promise<unknown> | undefined;
    bridge.beforeSigned = async () => {
      holding = getDb().transaction(async (tx) => {
        await tx.select().from(connections).where(eq(connections.id, t.connectionId)).for('update');
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      // Held just past the hash write's lock wait, so nothing after it waits on this row.
      setTimeout(release.resolve, LOCK_WAIT_MS + 1_000);
    };

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);
    await holding;

    expect(result.content[0].text).toMatch(/lost its turn on the float/);
    expect(bridge.sent).toEqual([]);
  }, 120_000);

  it('given another holder took the float while the userOp was being signed, then its hash is not recorded and nothing is sent', async () => {
    const { c, t, permissionId } = await withCustomGrant();
    bridge.beforeSigned = async () => {
      await getDb()
        .update(connections)
        .set({ floatFence: sql`${connections.floatFence} + 1` })
        .where(eq(connections.id, t.connectionId));
    };

    const result = await execute(c.access_token, permissionId, [transfer(BOB, 1n)]);

    expect(result.content[0].text).toMatch(/lost its turn on the float/);
    expect(bridge.sent).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([expect.objectContaining({ state: 'released', callsId: null })]);
  });
});
