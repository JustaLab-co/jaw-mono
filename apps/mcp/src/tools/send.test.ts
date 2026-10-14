import { eq } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { endConnection } from '@/connections/rows';
import { getDb } from '@/db/client';
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
}));
// Set to make every float turn find its lock taken by another turn when it checks.
const fence = vi.hoisted(() => ({ lost: false }));
vi.mock('@/payments/float-lock', async (original) => {
  const real = await original<typeof import('@/payments/float-lock')>();
  return {
    ...real,
    withFloat: <T>(id: string, waitMs: number, work: (hold: FloatHold) => Promise<T>) =>
      real.withFloat(id, waitMs, (hold) => work(fence.lost ? { ...hold, owns: async () => false } : hold)),
  };
});
vi.mock('@/adapters/session-host', async (original) => ({
  ...(await original<object>()),
  sessionBridge: () => ({
    request: async (method: string, params: unknown) => {
      if (method === 'wallet_sendCalls') {
        if (bridge.fail && !bridge.taken) throw bridge.fail;
        bridge.sent.push((params as [{ calls: { to: Address; data: Hex }[] }])[0].calls);
        if (bridge.fail) throw bridge.fail;
        return { id: `0x${'b'.repeat(64)}` };
      }
      return { status: bridge.status, receipts: [{ transactionHash: `0x${'c'.repeat(64)}` }] };
    },
  }),
}));

const chain = vi.hoisted(() => ({ permissionId: '0x', headUnreadable: false }));
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
  await getDb().delete(settings);
});

async function sender() {
  const c = await connect(undefined, { scope: 'wallet:read wallet:send' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  chain.permissionId = (await currentGrant(t.connectionId))?.permissionId ?? '0x';
  return { c, t };
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

describe.skipIf(!TEST_PG_URL)('on Postgres, given another turn holding the float lock', () => {
  beforeAll(useTestPostgres);

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
