import type { GrantRequest } from '@jaw.id/agent';
import type { PublicClient } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decideFromPage, readForPage } from '@/approvals/page-api';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, setTestEnv, verifyLocally } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { payments } from '@/db/schema';
import { useTestDb } from '@/db/test-db';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const asked: { id: string }[] = [];

// The permission manager answers for whichever permission is asked about: approved,
// not revoked, nothing spent this period, so any spend in jaw_status comes from elsewhere.
vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () =>
    ({
      readContract: async ({ functionName, args }: { functionName: string; args: [{ salt: bigint }] }) => {
        if (functionName === 'getHash') return asked[asked.length - 1].id;
        if (functionName === 'getCurrentPeriod') return { start: 1, end: 2_000_000_000, spend: 0n };
        return functionName === 'isApproved';
      },
    }) as unknown as PublicClient,
}));

setTestEnv();
beforeAll(useTestDb);

async function approve(c: Awaited<ReturnType<typeof connect>>, perDay: string) {
  const id = (await callTool(c.access_token, 'jaw_request_budget', { perDay })).structuredContent.requestId as string;
  const read = await readForPage(id);
  if (read.kind !== 'ok' || read.view.approve.type !== 'grant') throw new Error('no budget view');
  const grant: GrantRequest = read.view.approve.grant;
  const permissionId = `0x${Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64)}`;
  const permission = {
    permissionId,
    account: grant.address,
    spender: grant.spender,
    start: 1_780_000_000,
    end: grant.expiry,
    salt: '0x1',
    calls: [{ target: USDC, selector: '0xa9059cbb' }],
    spends: grant.permissions.spends,
  };
  await decideFromPage(
    id,
    { verdict: 'approved', previewHash: read.view.previewHash, permission },
    verifyLocally,
    new Date(),
    async () => ({
      status: 'ok',
      approved: true,
      revoked: false,
    })
  );
  asked.push({ id: permissionId });
  return permissionId;
}

describe('jaw_status after a budget change', () => {
  it('counts what the replaced budget pulled today in spentToday and remainingToday', async () => {
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
    const status = await callTool(c.access_token, 'jaw_status', {});
    expect(status.structuredContent.budget).toMatchObject({
      perDay: { amount: '1000000' },
      spentToday: { amount: '700000' },
      remainingToday: { amount: '300000' },
    });
  });
});
