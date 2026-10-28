import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PublicClient } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  approvedOnChain,
  callTool,
  connect,
  mcp,
  fakeWallet,
  setTestEnv,
  walletAnswers,
  walletsSettled,
  offlineSession,
  noCodeRead,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { payments } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { x402Budget } from '@/grants/store';
import { grantPermissions } from '@/tools/grant-permissions';
import { leaks, spoken } from '@/test-utils/spoken';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const asked: { id: string }[] = [];
const sessions = new Set<string>();
const initial = {
  start: 1,
  end: 2_000_000_000,
  spend: 0n,
  held: 0n,
  permit2: 0n as bigint | undefined,
  funds: 5_000_000n as bigint | undefined,
  periodReadable: true,
  floatReadable: true,
  approved: true,
  livenessReadable: true,
};
const chain = { ...initial };
const unreadable = (n: bigint | undefined) => {
  if (n === undefined) throw new Error('rpc down');
  return n;
};

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () =>
    ({
      readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === 'getHash') return asked[asked.length - 1].id;
        if (functionName === 'getCurrentPeriod') {
          if (!chain.periodReadable) throw new Error('rpc down');
          return chain;
        }
        if (functionName === 'balanceOf')
          return sessions.has(String(args[0]).toLowerCase())
            ? unreadable(chain.floatReadable ? chain.held : undefined)
            : unreadable(chain.funds);
        if (functionName === 'allowance') {
          if (chain.permit2 === undefined) throw new Error('rpc down');
          return chain.permit2;
        }
        if (functionName === 'isApproved' && !chain.livenessReadable) throw new Error('rpc down');
        return functionName === 'isApproved' && chain.approved;
      },
    }) as unknown as PublicClient,
}));

const option = (amount: string, asset: string, scheme = 'exact') => ({
  scheme,
  network: 'eip155:84532',
  amount,
  asset,
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2', facilitatorAddress: '0x2222222222222222222222222222222222222222' },
});
const seller = createServer((req, res) => {
  const price = req.url?.match(/^\/(?:price|upto)\/(\d+)$/)?.[1];
  const accepts = price
    ? [option(price, USDC, req.url?.startsWith('/upto') ? 'upto' : 'exact')]
    : req.url === '/two'
      ? [option('1', '0x3333333333333333333333333333333333333333'), option('5000', USDC)]
      : req.url === '/other'
        ? [option('1', '0x3333333333333333333333333333333333333333')]
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
process.env.JAW_MCP_API_KEY = 'paymaster-test-key';
process.env.JAW_MCP_INSECURE_FETCH_HOSTS = SELLER;
beforeAll(useTestDb);
beforeEach(() => Object.assign(chain, initial));

async function withBudget(perDay: string) {
  const c = await connect();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const wallet = fakeWallet(walletAnswers(c.signer));
  await grantPermissions(
    t,
    { x402Budget: { perDay } },
    { codeAt: noCodeRead, openWallet: wallet, readPermission: approvedOnChain, session: offlineSession }
  );
  await walletsSettled();
  const permissionId = (await x402Budget(t.connectionId))!.permissionId;
  asked.push({ id: permissionId });
  sessions.add(t.sessionAddress.toLowerCase());
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
      budget: { permissionId, remainingToday: { amount: '490000', asset: `eip155:84532/erc20:${USDC}` } },
    });
    expect(r.structuredContent.summary).not.toContain(permissionId);
    expect(r.structuredContent.summary).toBe(
      `${SELLER} charges 1 USDC per call. The spend limit has 0.49 USDC left today, not enough for it.\nFor the agent: Offer to wait for the daily reset or to ask the owner for a higher spend limit.`
    );
    expect(leaks(spoken(r))).toEqual([]);
  });

  it('when the quote is exactly what is left, 0.01 under the day for the refill fee, then it is ready', async () => {
    const { token, permissionId } = await withBudget('0.5');
    const r = await quote(token, '/price/490000');
    expect(r.structuredContent).toMatchObject({
      readiness: { status: 'ready' },
      budget: { permissionId, remainingToday: { amount: '490000' } },
    });
  });

  it('when the quote is the whole 0.5 USDC and the float is empty, then it is over the allowance: the refill pays its own fee', async () => {
    const { token } = await withBudget('0.5');
    const r = await quote(token, '/price/500000');
    expect(r.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'over_allowance' });
  });

  it('when the seller also offers a cheaper token the budget does not hold, then the quote prices the USDC option', async () => {
    const { token } = await withBudget('0.5');
    const r = await quote(token, '/two');
    expect(r.structuredContent).toMatchObject({
      price: { amount: '5000', asset: `eip155:84532/erc20:${USDC}` },
      readiness: { status: 'ready' },
    });
  });

  it('when the seller offers only a token the budget does not hold, then the quote is refused not_allowed, under the policy pay applies', async () => {
    const { token } = await withBudget('0.5');
    const r = await quote(token, '/other');
    expect(r.structuredContent).toMatchObject({ kind: 'refused', refusal: { code: 'not_allowed' } });
  });

  it('when the owner revoked it on chain, then a paid quote is not ready, carries no budget and does not say it fits', async () => {
    const { token } = await withBudget('0.5');
    chain.approved = false;
    const r = await quote(token, '/price/5000');
    expect(r.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'grant_revoked' });
    expect(r.structuredContent.budget).toBeUndefined();
    expect(r.structuredContent.summary).not.toContain('budget');
    expect(r.structuredContent.summary).not.toContain('Within');
  });

  it('when whether the chain still approves it cannot be read, then a paid quote is not ready, carries no budget and does not say it fits', async () => {
    const { token } = await withBudget('0.5');
    chain.livenessReadable = false;
    const r = await quote(token, '/price/5000');
    expect(r.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'chain_unavailable' });
    expect(r.structuredContent.budget).toBeUndefined();
    expect(r.structuredContent.summary).not.toContain('budget');
    expect(r.structuredContent.summary).not.toContain('Within');
  });

  it('when the account behind the budget cannot be read and the float needs a refill, then the quote is not ready for chain_unavailable', async () => {
    const { token } = await withBudget('0.5');
    chain.funds = undefined;
    const r = await quote(token, '/price/5000');
    expect(r.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'chain_unavailable' });
    expect(r.structuredContent.summary).not.toContain('Within');
  });

  it('when an upto price cannot read the Permit2 allowance, then the quote is not ready for chain_unavailable', async () => {
    const { token } = await withBudget('0.5');
    chain.permit2 = undefined;
    const r = await quote(token, '/upto/5000');
    expect(r.structuredContent).toMatchObject({ scheme: 'upto' });
    expect(r.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'chain_unavailable' });
    expect(r.structuredContent.summary).not.toContain('Within');
  });

  it('when the session float cannot be read, then a price the float would have paid is not ready for chain_unavailable', async () => {
    const { token } = await withBudget('0.5');
    Object.assign(chain, { held: 500_000n, floatReadable: false });
    const r = await quote(token, '/price/495000');
    expect(r.structuredContent.readiness).toEqual({ status: 'not_ready', reason: 'chain_unavailable' });
    expect(r.structuredContent.summary).not.toContain('Within');
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

describe('given a budget of 1 USDC a day', () => {
  it('when the quote is 5000 base units, then it is ready with 990000 left today after the refill fee', async () => {
    const { token, permissionId } = await withBudget('1');
    const r = await quote(token, '/price/5000');
    expect(r.structuredContent).toMatchObject({
      readiness: { status: 'ready' },
      budget: { permissionId, remainingToday: { amount: '990000' } },
    });
    expect(r.structuredContent.summary).toBe(
      `${SELLER} charges 0.005 USDC per call. Within the spend limit, which has 0.99 USDC left today.`
    );
    expect(leaks(spoken(r))).toEqual([]);
  });
});

describe('given a budget of 0.03 USDC with 0.025 funded into the float today and 0.02 still held there', () => {
  it('when the quote is the 0.02 held, then the float counts, it is ready, and it agrees with jaw_session_status', async () => {
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
    const r = await quote(token, '/price/20000');
    const status = await callTool(token, 'jaw_session_status', {});
    expect(r.structuredContent).toMatchObject({
      readiness: { status: 'ready' },
      budget: { permissionId, remainingToday: { amount: '20000' } },
    });
    expect(status.structuredContent.budget.remainingToday).toEqual(r.structuredContent.budget.remainingToday);
  });
});

describe('given the tool list', () => {
  it('when a client reads the output schemas, then only jaw_session_x402_quote can answer over_allowance', async () => {
    const { token } = await withBudget('0.5');
    const { json } = await mcp(token, { method: 'tools/list' });
    const reasons = (name: string) =>
      json.result.tools.find((t: { name: string }) => t.name === name).outputSchema.properties.readiness.properties
        .reason.enum;
    expect(reasons('jaw_session_x402_quote')).toContain('over_allowance');
    expect(reasons('jaw_session_status')).not.toContain('over_allowance');
  });
});
