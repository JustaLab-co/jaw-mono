import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PublicClient } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { payments } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { x402Budget } from '@/grants/store';
import { grantPermissions } from '@/tools/grant-permissions';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const asked: { id: string }[] = [];
const chain = { start: 1, end: 2_000_000_000, spend: 0n, held: 0n, periodReadable: true };

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () =>
    ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getHash') return asked[asked.length - 1].id;
        if (functionName === 'getCurrentPeriod') {
          if (!chain.periodReadable) throw new Error('rpc down');
          return chain;
        }
        if (functionName === 'balanceOf') return chain.held;
        return functionName === 'isApproved';
      },
    }) as unknown as PublicClient,
}));

const option = (amount: string, asset: string) => ({
  scheme: 'exact',
  network: 'eip155:84532',
  amount,
  asset,
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
});
const seller = createServer((req, res) => {
  const price = req.url?.match(/^\/price\/(\d+)$/)?.[1];
  const accepts = price
    ? [option(price, USDC)]
    : req.url === '/two'
      ? [option('1', '0x3333333333333333333333333333333333333333'), option('5000', USDC)]
      : undefined;
  if (!accepts) {
    res.end('free');
    return;
  }
  const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}` }, accepts };
  res.writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') }).end('{}');
});
await new Promise<void>((r) => seller.listen(0, '127.0.0.1', r));
const SELLER = `127.0.0.1:${(seller.address() as AddressInfo).port}`;

setTestEnv();
process.env.JAW_MCP_INSECURE_FETCH_HOSTS = SELLER;
beforeAll(useTestDb);
beforeEach(() => Object.assign(chain, { start: 1, end: 2_000_000_000, spend: 0n, held: 0n, periodReadable: true }));

async function withBudget(perDay: string) {
  const c = await connect();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const wallet = fakeWallet(walletAnswers(c.signer));
  await grantPermissions(t, { x402Budget: { perDay } }, { openWallet: wallet, readPermission: approvedOnChain });
  await walletsSettled();
  const permissionId = (await x402Budget(t.connectionId))!.permissionId;
  asked.push({ id: permissionId });
  return { token: c.access_token, t, permissionId };
}

const quote = (token: string, path: string) =>
  callTool(token, 'jaw_session_x402_quote', { url: `http://${SELLER}${path}` });

describe('given a budget of 0.5 USDC a day', () => {
  it('when the quote is 1 USDC, then it is not ready over the allowance and names the budget and what it has left', async () => {
    const { token, permissionId } = await withBudget('0.5');
    const r = await quote(token, '/price/1000000');
    expect(r.structuredContent).toMatchObject({
      kind: 'paid',
      price: { amount: '1000000' },
      readiness: { status: 'not_ready', reason: 'over_allowance' },
      budget: { permissionId, remainingToday: { amount: '500000', asset: `eip155:84532/erc20:${USDC}` } },
    });
    expect(r.structuredContent.summary).toContain(permissionId);
    expect(r.structuredContent.summary).toContain('500000');
  });

  it('when the quote is exactly 0.5 USDC, then it is ready', async () => {
    const { token, permissionId } = await withBudget('0.5');
    const r = await quote(token, '/price/500000');
    expect(r.structuredContent).toMatchObject({
      readiness: { status: 'ready' },
      budget: { permissionId, remainingToday: { amount: '500000' } },
    });
  });

  it('when the seller also offers a cheaper token the budget does not hold, then the quote prices the USDC option', async () => {
    const { token } = await withBudget('0.5');
    const r = await quote(token, '/two');
    expect(r.structuredContent).toMatchObject({
      price: { amount: '5000', asset: `eip155:84532/erc20:${USDC}` },
      readiness: { status: 'ready' },
    });
  });

  it('when the day cannot be read from the chain, then a paid quote is not ready for chain_unavailable', async () => {
    const { token } = await withBudget('0.5');
    chain.periodReadable = false;
    const r = await quote(token, '/price/5000');
    expect(r.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'chain_unavailable' });
  });

  it('when the resource is free, then it is ready and carries no budget', async () => {
    const { token } = await withBudget('0.5');
    const r = await quote(token, '/free');
    expect(r.structuredContent.kind).toBe('free');
    expect(r.structuredContent.readiness).toEqual({ status: 'ready' });
    expect(r.structuredContent.budget).toBeUndefined();
  });
});

describe('given a budget of 0.03 USDC with 0.025 funded into the float today and 0.02 still held there', () => {
  it('when the quote is 0.025 USDC, then the float counts, it is ready, and it agrees with jaw_session_status', async () => {
    const { token, t, permissionId } = await withBudget('0.03');
    await getDb().insert(payments).values({
      id: 'pay_quotefloat',
      connectionId: t.connectionId,
      idempotencyKey: 'quote-float',
      requestHash: 'h',
      permissionId,
      payer: t.sessionAddress.toLowerCase(),
      url: 'https://seller.example/x',
      state: 'failed',
      kind: 'refused',
      code: 'over_cap',
      leaseUntil: new Date(),
      topUpAmount: '25000',
      finishedAt: new Date(),
    });
    Object.assign(chain, { spend: 25_000n, held: 20_000n });
    const r = await quote(token, '/price/25000');
    const status = await callTool(token, 'jaw_session_status', {});
    expect(r.structuredContent).toMatchObject({
      readiness: { status: 'ready' },
      budget: { permissionId, remainingToday: { amount: '25000' } },
    });
    expect(status.structuredContent.budget.remainingToday).toEqual(r.structuredContent.budget.remainingToday);
  });
});
