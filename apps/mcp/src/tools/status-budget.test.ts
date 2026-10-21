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
  offlineSession,
} from '@/connections/testkit';
import { x402Budget } from '@/grants/store';
import { grantPermissions } from '@/tools/grant-permissions';
import { getDb } from '@/db/client';
import { payments } from '@/db/schema';
import { useTestDb } from '@/db/test-db';

const asked: { id: string; salt: bigint }[] = [];
const revokedInWallet = new Set<string>();
const unreadable = new Set<string>();
const idOf = (salt: bigint) => asked.find((a) => a.salt === salt)?.id ?? asked[asked.length - 1].id;
const chain = { start: 1, end: 2_000_000_000, spend: 0n, held: 0n };

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () =>
    ({
      readContract: async ({ functionName, args }: { functionName: string; args: [{ salt: bigint }] }) => {
        if (unreadable.has(idOf(args[0].salt))) throw new Error('node down');
        if (functionName === 'getHash') return idOf(args[0].salt);
        if (functionName === 'isRevoked') return revokedInWallet.has(idOf(args[0].salt));
        if (functionName === 'getCurrentPeriod') return chain;
        if (functionName === 'balanceOf') return chain.held;
        return functionName === 'isApproved';
      },
    }) as unknown as PublicClient,
}));

setTestEnv();
beforeAll(useTestDb);
beforeEach(() => Object.assign(chain, { start: 1, end: 2_000_000_000, spend: 0n, held: 0n }));

/** The owner approves a new budget in their wallet; the chain mock then answers for it. */
async function approve(c: Awaited<ReturnType<typeof connect>>, perDay: string) {
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const wallet = fakeWallet(walletAnswers(c.signer));
  await grantPermissions(
    t,
    { x402Budget: { perDay } },
    { openWallet: wallet, session: offlineSession, readPermission: approvedOnChain }
  );
  await walletsSettled();
  const grant = (await x402Budget(t.connectionId))!;
  asked.push({ id: grant.permissionId, salt: BigInt(grant.permission.salt) });
  return grant.permissionId;
}

describe('jaw_session_status after a budget change', () => {
  it('counts what an older budget pulled today in remainingToday', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const old = await approve(c, '2');
    await getDb().insert(payments).values({
      id: 'pay_oldgrantpull',
      connectionId: t.connectionId,
      idempotencyKey: 'old-pull',
      requestHash: 'h',
      permissionId: old,
      payer: t.sessionAddress.toLowerCase(),
      url: 'https://seller.example/x',
      state: 'failed',
      kind: 'refused',
      code: 'over_cap',
      leaseUntil: new Date(),
      topUpAmount: '700000',
      finishedAt: new Date(),
    });
    await approve(c, '1');
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      perDay: { amount: '1000000' },
      spentToday: { amount: '0' },
      remainingToday: { amount: '290000' },
    });
  });
});

describe('given two budgets and the newer one revoked in the wallet', () => {
  it('when jaw_session_status runs, then it is ready and describes the older budget, the one payments draw from', async () => {
    const c = await connect();
    const older = await approve(c, '2');
    const newer = await approve(c, '1');
    revokedInWallet.add(newer);
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.readiness).toMatchObject({ status: 'ready' });
    expect(status.structuredContent.budget).toMatchObject({ permissionId: older, perDay: { amount: '2000000' } });
  });

  it('when jaw_session_x402_quote runs, then it is ready, judged on the older budget as a payment would be', async () => {
    const c = await connect();
    await approve(c, '2');
    const newer = await approve(c, '1');
    revokedInWallet.add(newer);
    const quote = await callTool(c.access_token, 'jaw_session_x402_quote', { url: 'https://169.254.169.254/latest' });
    expect(quote.structuredContent.readiness).toMatchObject({ status: 'ready' });
  });
});

describe('given three budgets, the newest revoked in the wallet and the middle one unreadable', () => {
  it('when jaw_session_status runs, then it says the chain is unavailable, as a payment would', async () => {
    const c = await connect();
    await approve(c, '3');
    const middle = await approve(c, '2');
    const newest = await approve(c, '1');
    revokedInWallet.add(newest);
    unreadable.add(middle);
    try {
      const status = await callTool(c.access_token, 'jaw_session_status', {});
      expect(status.structuredContent.readiness).toMatchObject({ status: 'not_ready', reason: 'chain_unavailable' });
    } finally {
      unreadable.delete(middle);
    }
  });
});

describe('given a budget of 0.03 USDC with 0.025 already funded into the float today', () => {
  it('when jaw_session_status runs, then remainingToday is what pay can still pull', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const current = await approve(c, '0.03');
    await getDb().insert(payments).values({
      id: 'pay_floatfunded',
      connectionId: t.connectionId,
      idempotencyKey: 'float-funded',
      requestHash: 'h',
      permissionId: current,
      payer: t.sessionAddress.toLowerCase(),
      url: 'https://seller.example/x',
      state: 'failed',
      kind: 'refused',
      code: 'over_cap',
      leaseUntil: new Date(),
      topUpAmount: '25000',
      finishedAt: new Date(),
    });
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      perDay: { amount: '30000' },
      spentToday: { amount: '0' },
      remainingToday: { amount: '0' },
    });
  });
});

async function fundedRow(t: Tenant, permissionId: string, id: string, amount: string, at: Date) {
  await getDb().insert(payments).values({
    id,
    connectionId: t.connectionId,
    idempotencyKey: id,
    requestHash: 'h',
    permissionId,
    payer: t.sessionAddress.toLowerCase(),
    url: 'https://seller.example/x',
    state: 'failed',
    kind: 'refused',
    code: 'over_cap',
    leaseUntil: at,
    topUpAmount: amount,
    createdAt: at,
    finishedAt: at,
  });
}

describe('given the chain counts more spent today than the ledger topped up', () => {
  it('when jaw_session_status runs, then remainingToday follows the chain and the difference is spent', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const current = await approve(c, '0.05');
    await fundedRow(t, current, 'pay_chainahead', '10000', new Date());
    Object.assign(chain, { start: 1, spend: 20_000n });
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '10000' },
      remainingToday: { amount: '20000' },
    });
  });
});

describe('given a top-up dated before the current window started', () => {
  it('when jaw_session_status runs, then that top-up is not counted', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const current = await approve(c, '0.05');
    const now = Date.now();
    await fundedRow(t, current, 'pay_beforewindow', '25000', new Date(now - 2 * 3_600_000));
    Object.assign(chain, { start: Math.floor(now / 1000) - 3600, spend: 0n });
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '0' },
      remainingToday: { amount: '40000' },
    });
  });
});

describe('given a window start past the range a Date can hold', () => {
  it('when jaw_session_status runs, then it still answers and counts every top-up', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const current = await approve(c, '0.05');
    await fundedRow(t, current, 'pay_unreadablestart', '25000', new Date());
    Object.assign(chain, { start: 99_999_999_999_999, end: 99_999_999_999_999, spend: 0n });
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '0' },
      remainingToday: { amount: '15000' },
      resetsAt: null,
    });
  });
});

async function paidRow(t: Tenant, permissionId: string, id: string, amount: string) {
  await getDb()
    .insert(payments)
    .values({
      id,
      connectionId: t.connectionId,
      idempotencyKey: id,
      requestHash: 'h',
      permissionId,
      payer: t.sessionAddress.toLowerCase(),
      url: 'https://seller.example/x',
      state: 'settled',
      kind: 'paid',
      nonce: `0x${id}`,
      leaseUntil: new Date(),
      amount,
      finishedAt: new Date(),
    });
}

describe('given the session already holds float from an earlier pull', () => {
  it('when jaw_session_status runs, then the summary reports only what is left today', async () => {
    const c = await connect();
    await approve(c, '0.05');
    chain.held = 28_143n;
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '0' },
      remainingToday: { amount: '50000' },
    });
    expect(status.structuredContent.summary).toContain('Ready to pay, 50000 base units left today.');
    expect(status.structuredContent.summary).not.toContain('held by the session');
  });
});

describe('given 1 USDC a day, float from an earlier window and 0.9 paid today', () => {
  it('when jaw_session_status runs, then remainingToday is what the daily cap still allows', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const current = await approve(c, '1');
    const now = Date.now();
    await fundedRow(t, current, 'pay_earlierfloat', '1500000', new Date(now - 2 * 3_600_000));
    Object.assign(chain, { start: Math.floor(now / 1000) - 3600, spend: 0n, held: 600_000n });
    for (const id of ['pay_today1', 'pay_today2', 'pay_today3']) await paidRow(t, current, id, '300000');
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '900000' },
      remainingToday: { amount: '100000' },
    });
    expect(status.structuredContent.summary).toContain('100000 base units left today.');
  });
});

describe('given 1 USDC pulled today into the float and nothing paid yet', () => {
  it('when jaw_session_status runs, then the whole day is still left', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const current = await approve(c, '1');
    await fundedRow(t, current, 'pay_fullpull', '1000000', new Date());
    Object.assign(chain, { spend: 1_000_000n, held: 1_000_000n });
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '0' },
      remainingToday: { amount: '1000000' },
    });
  });
});

describe('given 1 USDC pulled today, 0.69 paid and 0.29 left in the float', () => {
  it('when jaw_session_status runs, then remainingToday is the float, since nothing more can be pulled', async () => {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const current = await approve(c, '1');
    await fundedRow(t, current, 'pay_g1pull', '1000000', new Date());
    await paidRow(t, current, 'pay_g1paid', '690000');
    Object.assign(chain, { spend: 1_000_000n, held: 290_000n });
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      spentToday: { amount: '690000' },
      remainingToday: { amount: '290000' },
    });
  });
});

describe('given 1 USDC a day and the reads jaw_session_status combines', () => {
  async function budgetAfter(setup: (t: Tenant, permissionId: string) => Promise<void>) {
    const c = await connect();
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    await setup(t, await approve(c, '1'));
    const status = await callTool(c.access_token, 'jaw_session_status', {});
    return status.structuredContent;
  }

  it('when only a payment ran today, then it is spent and the rest is left for both actions', async () => {
    const out = await budgetAfter(async (t, id) => {
      await fundedRow(t, id, 'pay_onlypull', '100000', new Date());
      await paidRow(t, id, 'pay_onlypaid', '100000');
      Object.assign(chain, { spend: 100_000n, held: 0n });
    });
    expect(out.budget).toMatchObject({
      spentToday: { amount: '100000' },
      remainingToday: { amount: '890000' },
    });
    expect(out.summary).toContain('Ready to pay, 890000 base units left today.');
  });

  it('when only 0.01 left the account, with float held from an earlier day, then it is spent', async () => {
    const out = await budgetAfter(async () => {
      Object.assign(chain, { spend: 10_000n, held: 28_143n });
    });
    expect(out.budget).toMatchObject({
      spentToday: { amount: '10000' },
      remainingToday: { amount: '990000' },
    });
    expect(out.summary).toContain('Ready to pay, 990000 base units left today.');
  });

  it('when a payment and a 0.01 spend outside it ran, then both are spent', async () => {
    const out = await budgetAfter(async (t, id) => {
      await fundedRow(t, id, 'pay_bothpull', '100000', new Date());
      await paidRow(t, id, 'pay_bothpaid', '100000');
      Object.assign(chain, { spend: 110_000n, held: 0n });
    });
    expect(out.budget).toMatchObject({
      spentToday: { amount: '110000' },
      remainingToday: { amount: '880000' },
    });
  });

  it('when a refill, a payment out of it and a 0.01 spend outside it ran, then the refill is not spent twice', async () => {
    const out = await budgetAfter(async (t, id) => {
      await fundedRow(t, id, 'pay_refillpull', '200000', new Date());
      await paidRow(t, id, 'pay_refillpaid', '150000');
      Object.assign(chain, { spend: 210_000n, held: 50_000n });
    });
    expect(out.budget).toMatchObject({
      spentToday: { amount: '160000' },
      remainingToday: { amount: '830000' },
    });
    expect(out.summary).toContain('Ready to pay, 830000 base units left today.');
  });

  it('when 0.99 left the account outside payments and the float holds more than is left, then 0.01 is left', async () => {
    const out = await budgetAfter(async () => {
      Object.assign(chain, { spend: 990_000n, held: 28_143n });
    });
    expect(out.budget).toMatchObject({
      spentToday: { amount: '990000' },
      remainingToday: { amount: '10000' },
    });
  });

  it('when 0.9 was paid today from an earlier day float, then a send is held to what the day has left', async () => {
    const out = await budgetAfter(async (t, id) => {
      const now = Date.now();
      await fundedRow(t, id, 'pay_oldfloat', '900000', new Date(now - 2 * 3_600_000));
      Object.assign(chain, { start: Math.floor(now / 1000) - 3600, spend: 0n, held: 0n });
      await paidRow(t, id, 'pay_fromoldfloat', '900000');
    });
    expect(out.budget).toMatchObject({
      spentToday: { amount: '900000' },
      remainingToday: { amount: '100000' },
    });
  });
});
