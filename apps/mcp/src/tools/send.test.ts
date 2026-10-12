import { eq } from 'drizzle-orm';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
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
import { grants, settings } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { requestBudget } from './request-budget';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BOB: Address = '0x2222222222222222222222222222222222222222';

// The session key's sends, and what the chain says about each batch.
const bridge = vi.hoisted(() => ({
  sent: [] as { to: Address; data: Hex }[][],
  status: 200,
}));
vi.mock('@/adapters/session-host', async (original) => ({
  ...(await original<object>()),
  sessionBridge: () => ({
    request: async (method: string, params: unknown) => {
      if (method === 'wallet_sendCalls') {
        bridge.sent.push((params as [{ calls: { to: Address; data: Hex }[] }])[0].calls);
        return { id: `0x${'b'.repeat(64)}` };
      }
      return { status: bridge.status, receipts: [{ transactionHash: `0x${'c'.repeat(64)}` }] };
    },
  }),
}));

setTestEnv();
beforeAll(useTestDb);
afterEach(async () => {
  bridge.sent.length = 0;
  bridge.status = 200;
  await getDb().delete(settings);
});

async function sender(calls: { target: Address; functionSignature: string }[] = []) {
  const c = await connect(undefined, { scope: 'wallet:read wallet:send' });
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  if (calls.length) {
    await requestBudget(t, '1', calls, {
      openWallet: fakeWallet(walletAnswers(c.signer)),
      readPermission: approvedOnChain,
      ...offlineSession,
    });
    await walletsSettled();
  }
  return { c, t };
}

const approveCall = (spender: Address) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 1n] });

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
});

describe('jaw_send_calls', () => {
  it('runs a call the budget lists', async () => {
    const { c } = await sender([{ target: USDC, functionSignature: 'approve(address,uint256)' }]);
    const calls = [{ to: USDC, data: approveCall(BOB) }];
    const result = await callTool(c.access_token, 'jaw_send_calls', { calls });
    expect(result.structuredContent).toMatchObject({ status: 'landed' });
    expect(bridge.sent).toEqual([calls]);
  });

  it('given a call the budget does not list, then it refuses naming how to ask for it, and sends none of the batch', async () => {
    const { c } = await sender();
    const calls = [
      { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BOB, 1n] }) },
      { to: USDC, data: approveCall(BOB) },
    ];
    const result = await callTool(c.access_token, 'jaw_send_calls', { calls });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('0x095ea7b3');
    expect(result.content[0].text).toContain('jaw_request_budget');
    expect(bridge.sent).toEqual([]);
  });

  it('given a function the budget lists on another contract, then it refuses: a listing names a contract, not just a function', async () => {
    const { c } = await sender([{ target: USDC, functionSignature: 'approve(address,uint256)' }]);
    const elsewhere: Address = '0x3333333333333333333333333333333333333333';
    const result = await callTool(c.access_token, 'jaw_send_calls', {
      calls: [{ to: elsewhere, data: approveCall(BOB) }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(elsewhere);
    expect(bridge.sent).toEqual([]);
  });
});
