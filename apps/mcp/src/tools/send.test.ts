import { eq } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { endConnection } from '@/connections/rows';
import { floatHolder, getDb, setDb } from '@/db/client';
import { connections, grants, sends, settings } from '@/db/schema';
import { lockWaiters, TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { currentGrant } from '@/grants/store';
import { withFloat, type FloatHold } from '@/payments/float-lock';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BOB: Address = '0x2222222222222222222222222222222222222222';

// The session key's sends, and what the chain says about each batch. With `fail` set,
// wallet_sendCalls throws it, after the bundler took the batch if `taken` is set.
const bridge = vi.hoisted(() => ({
  sent: [] as { to: Address; data: Hex }[][],
  status: 200,
  fail: undefined as Error | undefined,
  taken: false,
  absent: false,
  statuses: [] as { status: number; receipts?: { transactionHash: string }[] }[],
  polls: 0,
}));
// Set to make every float turn find its lock taken by another turn when it checks.
const fence = vi.hoisted(() => ({ lost: false }));
vi.mock('@/payments/float-lock', async (original) => {
  const real = await original<typeof import('@/payments/float-lock')>();
  return {
    ...real,
    LOCK_WAIT_MS: 300,
    withFloat: <T>(id: string, waitMs: number, work: (hold: FloatHold) => Promise<T>) =>
      real.withFloat(id, waitMs, (hold) => work(fence.lost ? { ...hold, owns: async () => false } : hold)),
  };
});
vi.mock('@/adapters/session-host', async (original) => ({
  ...(await original<object>()),
  sessionBridge: () =>
    bridge.absent
      ? undefined
      : {
          request: async (method: string, params: unknown) => {
            if (method === 'wallet_sendCalls') {
              if (bridge.fail && !bridge.taken) throw bridge.fail;
              bridge.sent.push((params as [{ calls: { to: Address; data: Hex }[] }])[0].calls);
              if (bridge.fail) throw bridge.fail;
              return { id: `0x${'b'.repeat(64)}` };
            }
            bridge.polls++;
            const next = bridge.statuses.shift();
            if (next) return next;
            return { status: bridge.status, receipts: [{ transactionHash: `0x${'c'.repeat(64)}` }] };
          },
        },
}));

const chain = vi.hoisted(() => ({ permissionId: '0x', headUnreadable: false, periodUnreadable: false }));
vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () =>
    ({
      getBlockNumber: async () => {
        if (chain.headUnreadable) throw new Error('node down');
        return 77n;
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getHash') return chain.permissionId;
        if (functionName === 'getCurrentPeriod' && chain.periodUnreadable) throw new Error('node down');
        if (functionName === 'getCurrentPeriod') return { start: 1, end: 2_000_000_000, spend: 0n };
        throw new Error(`this node does not answer ${functionName}`);
      },
    }) as unknown as PublicClient,
}));

setTestEnv();
beforeAll(useTestDb);
afterEach(async () => {
  bridge.sent.length = 0;
  bridge.status = 200;
  bridge.fail = undefined;
  bridge.taken = false;
  fence.lost = false;
  chain.headUnreadable = false;
  chain.periodUnreadable = false;
  bridge.absent = false;
  bridge.statuses = [];
  bridge.polls = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await getDb().delete(settings);
});

async function sender() {
  const c = await connect(undefined, { scope: 'wallet:read wallet:send' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  chain.permissionId = (await currentGrant(t.connectionId))?.permissionId ?? '0x';
  return { c, t };
}

const TX = `0x${'c'.repeat(64)}`;
const CALLS = `0x${'b'.repeat(64)}`;
const rowsOf = (connectionId: string) => getDb().select().from(sends).where(eq(sends.connectionId, connectionId));
const transfer = (c: { access_token: string }, amount = '0.25', to: string = BOB) =>
  callTool(c.access_token, 'jaw_transfer', { to, amount });

// Polling waits 2 seconds between reads: here each wait costs nothing but moves the clock the same.
function fastPolling() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== 2_000) return real(fn, ms, ...rest);
    vi.setSystemTime(Date.now() + 2_000);
    return real(fn, 0);
  }) as typeof setTimeout);
}

describe('jaw_transfer', () => {
  it('sends USDC from the budget with no prompt to the owner, and answers with the transaction', async () => {
    const { c } = await sender();
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.structuredContent).toMatchObject({ status: 'landed', txHash: `0x${'c'.repeat(64)}` });
    expect(bridge.sent).toHaveLength(1);
    const [call] = bridge.sent[0];
    expect(call.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args).toEqual([BOB, 250_000n]);
  });

  it('given a client that reads only text, when jaw_transfer lands, then the last text block is the structured content as JSON', async () => {
    const { c } = await sender();
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.content[0].text).toBe(result.structuredContent.summary);
    expect(JSON.parse(result.content.at(-1).text)).toEqual(result.structuredContent);
  });

  it('given a transfer that reverts on chain, then it says so as an error', async () => {
    const { c } = await sender();
    bridge.status = 500;
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'reverted' });
  });

  it('given no budget, then it refuses pointing at jaw_request_budget and sends nothing', async () => {
    const { c, t } = await sender();
    await getDb().delete(grants).where(eq(grants.connectionId, t.connectionId));
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('jaw_request_budget');
    expect(bridge.sent).toEqual([]);
  });

  it('given payments paused on the server, then it refuses and sends nothing', async () => {
    const { c } = await sender();
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.isError).toBe(true);
    expect(bridge.sent).toEqual([]);
  });

  it('given a transfer whose turn on the float lock was taken by another, then it sends nothing and asks to try again', async () => {
    const { c } = await sender();
    fence.lost = true;
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nothing was sent');
    expect(result.content[0].text).toContain('Try again');
    expect(result.content[0].text).not.toContain('simulation');
    expect(bridge.sent).toEqual([]);
  });

  it('given a transfer the bundler took and whose answer timed out, then it says it may have been sent and to check first', async () => {
    const { c } = await sender();
    bridge.fail = new Error('The request took too long to respond.');
    bridge.taken = true;
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('may have been sent');
    expect(result.content[0].text).toContain('Check it before sending again');
    expect(result.content[0].text).not.toContain('Nothing was sent');
    expect(bridge.sent).toHaveLength(1);
  });

  it('given an amount of zero, then it refuses by name and sends nothing', async () => {
    const { c } = await sender();
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('A transfer of zero sends nothing.');
    expect(bridge.sent).toEqual([]);
  });

  it('given a head block the node cannot give, then it refuses as unreadable and sends nothing', async () => {
    const { c, t } = await sender();
    chain.headUnreadable = true;
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Nothing was sent: the budget could not be read from the chain right now.');
    expect(bridge.sent).toEqual([]);
    expect(await getDb().select().from(sends).where(eq(sends.connectionId, t.connectionId))).toEqual([]);
  });

  it('given a transfer over what the budget has left, refused in simulation, then it says nothing was sent', async () => {
    const { c } = await sender();
    bridge.fail = new Error(
      `Could not size the ERC-20 paymaster approval for token ${USDC} on chain 84532: execution reverted.`
    );
    const result = await callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nothing was sent');
    expect(result.content[0].text).not.toContain('may have been sent');
    expect(bridge.sent).toEqual([]);
  });
});

describe('the ledger row of a jaw_transfer', () => {
  it('given a transfer that lands, then the row is landed with the calls id, the hash and the head block', async () => {
    const { c, t } = await sender();
    await transfer(c);
    const [row] = await rowsOf(t.connectionId);
    expect(row).toMatchObject({ state: 'landed', txHash: TX, callsId: CALLS, amount: '250000', fromBlock: 77n });
  });

  it('given a transfer that reverts, then the row is released', async () => {
    const { c, t } = await sender();
    bridge.status = 500;
    await transfer(c);
    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'released', callsId: CALLS });
  });

  it('given a transfer refused in simulation, then the row is released', async () => {
    const { c, t } = await sender();
    bridge.fail = new Error(
      `Could not size the ERC-20 paymaster approval for token ${USDC} on chain 84532: execution reverted.`
    );
    await transfer(c);
    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'released' });
  });

  it('given a transfer the bundler took and whose answer timed out, then the row stays open for the reconciler', async () => {
    const { c, t } = await sender();
    bridge.fail = new Error('The request took too long to respond.');
    bridge.taken = true;
    await transfer(c);
    const [row] = await rowsOf(t.connectionId);
    expect(row.state).toBe('open');
    expect(row.leaseUntil.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('the receipt of a jaw_transfer', () => {
  it('given a receipt that never settles, then it is unconfirmed after a minute of reads and the row stays open', async () => {
    const { c, t } = await sender();
    bridge.statuses = Array.from({ length: 200 }, () => ({ status: 100 }));
    fastPolling();
    const result = await transfer(c);
    expect(result.structuredContent).toMatchObject({ status: 'unconfirmed', txHash: null, callsId: CALLS });
    expect(result.structuredContent.summary).toContain(`Submitted as ${CALLS}`);
    expect(bridge.polls).toBe(30);
    expect((await rowsOf(t.connectionId))[0]).toMatchObject({ state: 'open', callsId: CALLS });
  });

  it('given a success status without a receipt, then it is not landed yet', async () => {
    const { c } = await sender();
    bridge.statuses = [
      { status: 200, receipts: [] },
      { status: 200, receipts: [{ transactionHash: TX }] },
    ];
    fastPolling();
    const result = await transfer(c);
    expect(result.structuredContent).toMatchObject({ status: 'landed', txHash: TX });
  });

  it('given a status of exactly 400, then it is a revert and the row is released', async () => {
    const { c, t } = await sender();
    bridge.statuses = [{ status: 400 }];
    fastPolling();
    const result = await transfer(c);
    expect(result.structuredContent).toMatchObject({ status: 'reverted', txHash: null });
    expect((await rowsOf(t.connectionId))[0].state).toBe('released');
  });

  it('given a status below 400 that is not success, then it keeps reading', async () => {
    const { c } = await sender();
    bridge.statuses = [{ status: 399 }, { status: 200, receipts: [{ transactionHash: TX }] }];
    fastPolling();
    const result = await transfer(c);
    expect(result.structuredContent).toMatchObject({ status: 'landed' });
  });
});

describe('what jaw_transfer accepts', () => {
  it.each(['1234567890', '0.1234567', '-1', '1e3'])(
    'given the amount %s, then the schema refuses it before anything is read',
    async (amount) => {
      const { c, t } = await sender();
      const result = await transfer(c, amount);
      expect(result.content[0].text).toContain('Input validation error');
      expect(result.isError).toBe(true);
      expect(bridge.sent).toEqual([]);
      expect(await rowsOf(t.connectionId)).toEqual([]);
    }
  );

  it('given the largest amount the schema takes, then the schema accepts it and the budget refuses it', async () => {
    const { c } = await sender();
    const result = await transfer(c, '999999999.999999');
    expect(result.content[0].text).not.toContain('Input validation error');
    expect(bridge.sent).toEqual([]);
  });

  it('given a connection with only wallet:read, then it cannot transfer', async () => {
    const read = await connect(undefined, { scope: 'wallet:read' });
    const result = await transfer(read);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('wallet:send');
    expect(bridge.sent).toEqual([]);
  });

  it('given a name that does not resolve, then it is refused by name', async () => {
    const { c } = await sender();
    const result = await transfer(c, '0.25', 'nobody-here.invalid');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nobody-here.invalid');
    expect(result.content[0].text).toMatch(/could not be resolved|does not resolve/);
    expect(bridge.sent).toEqual([]);
  });

  it('given an address with a wrong checksum, then it is taken as the address it spells', async () => {
    const { c } = await sender();
    const miscased = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'.replace('d8dA6BF', 'D8Da6bf');
    await transfer(c, '0.25', miscased);
    const [call] = bridge.sent[0];
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args[0]).toBe(getAddress(miscased));
  });

  it('given the whole of what the budget has left, then it is allowed, and one unit more is refused', async () => {
    const { c, t } = await sender();
    const allowance = BigInt((await currentGrant(t.connectionId))!.allowance);
    const over = await transfer(c, (Number(allowance + 1n) / 1e6).toFixed(6));
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toContain('after payments and transfers');
    expect(bridge.sent).toEqual([]);

    const exact = await transfer(c, (Number(allowance) / 1e6).toFixed(6));
    expect(exact.structuredContent).toMatchObject({ status: 'landed' });
  });

  it('given an allowance the chain cannot give, then it refuses as unreadable and records nothing', async () => {
    const { c, t } = await sender();
    chain.periodUnreadable = true;
    const result = await transfer(c);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Nothing was sent: the budget could not be read from the chain right now.');
    expect(bridge.sent).toEqual([]);
    expect(await rowsOf(t.connectionId)).toEqual([]);
  });

  it('given a server without a paymaster key, then it refuses before reading anything', async () => {
    const { c } = await sender();
    bridge.absent = true;
    const result = await transfer(c);
    expect(result.content[0].text).toContain('no paymaster key');
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given another turn holding the float lock', () => {
  // Under shuffle the other tests can run after this block, so hand back the database they use.
  beforeAll(async () => {
    const [outer, holder] = [getDb(), floatHolder()];
    const drop = await useTestPostgres();
    return async () => {
      setDb(outer, holder);
      await drop();
    };
  });

  it('given a lock held past the wait, then the transfer is told a payment is in progress', async () => {
    const { c, t } = await sender();
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const release = Promise.withResolvers<void>();
    const holder = withFloat(t.connectionId, 5_000, async () => {
      locked();
      await release.promise;
    });
    await holding;

    const result = await transfer(c);
    release.resolve();
    await holder;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('A payment on this connection is in progress. Try again in a moment.');
    expect(bridge.sent).toEqual([]);
  });

  it('given a transfer waiting on the lock while the disconnect ends the connection, then the session key sends nothing', async () => {
    const { c, t } = await sender();
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    let parked = 0;
    // What jaw_disconnect does once its batch landed: end the connection under the float lock.
    const disconnecting = withFloat(t.connectionId, 5_000, async (hold) => {
      locked();
      for (let i = 0; i < 100 && parked === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        parked = await lockWaiters(t.connectionId);
      }
      await hold.tx((tx) => endConnection(t.connectionId, t.account, new Date(), tx));
    });
    await holding;
    const sending = callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    await disconnecting;
    const result = await sending;
    const [row] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
    expect(parked).toBe(1);
    expect(row.status).toBe('revoked');
    expect(bridge.sent).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('This connection has ended');
  });

  it('given a transfer waiting on the lock while the connection expires, then the session key sends nothing', async () => {
    const { c, t } = await sender();
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    let parked = 0;
    const expiring = withFloat(t.connectionId, 5_000, async (hold) => {
      locked();
      for (let i = 0; i < 100 && parked === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        parked = await lockWaiters(t.connectionId);
      }
      await hold.tx((tx) =>
        tx
          .update(connections)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(connections.id, t.connectionId))
      );
    });
    await holding;
    const sending = callTool(c.access_token, 'jaw_transfer', { to: BOB, amount: '0.25' });
    await expiring;
    const result = await sending;
    const [row] = await getDb().select().from(connections).where(eq(connections.id, t.connectionId));
    expect(parked).toBe(1);
    expect(row.status).toBe('active');
    expect(bridge.sent).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('This connection has ended');
  });
});
