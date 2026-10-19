import { randomBytes } from 'node:crypto';
import { toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { recordSend } from '@/payments/sends';
import { budgetConnection, callTool, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { useTestDb } from '@/db/test-db';
import { recordGrant } from '@/grants/permission';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NOW = () => Math.floor(Date.now() / 1000);

const chain = vi.hoisted(() => ({ ids: new Map<string, string>(), spend: new Map<string, bigint>(), held: 40_000n }));

vi.mock('@/lib/chain', async (original) => ({
  ...(await original<object>()),
  publicClientFor: () =>
    ({
      readContract: async ({ functionName, args }: { functionName: string; args: [{ salt: bigint }] }) => {
        const id = chain.ids.get(String(args?.[0]?.salt));
        if (functionName === 'getHash') return id;
        if (functionName === 'getCurrentPeriod') {
          return { start: NOW() - 60, end: NOW() + 3_600, spend: chain.spend.get(id!) ?? 0n };
        }
        if (functionName === 'balanceOf') return chain.held;
        return functionName === 'isApproved';
      },
    }) as unknown as PublicClient,
}));

setTestEnv();
beforeAll(useTestDb);

async function twoGrants() {
  const { c, tenant, permissionId, permission } = await budgetConnection();
  const customId = `0x${randomBytes(32).toString('hex')}` as Hex;
  const end = NOW() + 86_400;
  const custom = {
    account: tenant.account,
    spender: tenant.sessionAddress,
    start: NOW() - 60,
    end,
    salt: '0x02',
    calls: [{ target: USDC, selector: toFunctionSelector('transfer(address,uint256)') }],
    spends: [{ token: USDC, allowance: '500000', unit: 'day', multiplier: 1 }],
  };
  await getDb().transaction((tx) =>
    recordGrant(tx, tenant.connectionId, {
      permissionId: customId,
      kind: 'custom',
      chainId: tenant.chainId,
      account: tenant.account,
      spender: tenant.sessionAddress,
      token: USDC,
      allowance: '500000',
      period: 'day',
      permission: custom,
      expiresAt: new Date(end * 1000),
    })
  );
  chain.ids.set(String(BigInt((permission as { salt: string }).salt)), permissionId);
  chain.ids.set(String(BigInt(custom.salt)), customId);
  return { c, permissionId, customId };
}

type Shown = { permissionId: string; kind: string; active: boolean; limits: { allowance: string; left: string }[] };

describe('jaw_session_status with two grants', () => {
  it('lists each live grant with what its limit has left and the float at the payer', async () => {
    const { c, permissionId, customId } = await twoGrants();
    chain.spend.set(customId, 200_000n);
    chain.spend.set(permissionId, 300_000n);

    const r = await callTool(c.access_token, 'jaw_session_status', {});

    const grants = r.structuredContent.grants as Shown[];
    expect(grants.map((g) => g.permissionId).sort()).toEqual([permissionId, customId].sort());
    expect(grants.find((g) => g.permissionId === customId)).toMatchObject({
      kind: 'custom',
      active: true,
      limits: [{ allowance: '500000', left: '300000' }],
    });
    expect(grants.find((g) => g.permissionId === permissionId)!.limits).toEqual([
      expect.objectContaining({ allowance: '1000000', left: r.structuredContent.budget.remainingToday.amount }),
    ]);
    expect(r.structuredContent.float).toMatchObject({ amount: '40000' });
    expect(r.structuredContent).not.toHaveProperty('balances');
  });

  it('given a limit spent past its allowance, then left is zero', async () => {
    const { c, customId } = await twoGrants();
    chain.spend.set(customId, 600_000n);

    const r = await callTool(c.access_token, 'jaw_session_status', {});

    const custom = (r.structuredContent.grants as Shown[]).find((g) => g.permissionId === customId)!;
    expect(custom.limits[0].left).toBe('0');
  });
});

describe('jaw_session_status limits', () => {
  it('given an execute in flight, then the limit has it counted', async () => {
    const { c, customId } = await twoGrants();
    chain.spend.set(customId, 100_000n);
    const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    await getDb().transaction((tx) =>
      recordSend(tx, {
        connectionId: t.connectionId,
        idempotencyKey: 'k1',
        requestHash: 'h',
        permissionId: customId,
        chainId: t.chainId,
        sender: t.account,
        token: USDC,
        amount: 150_000n,
        periodStart: NOW() - 60,
        fromBlock: 1n,
      })
    );

    const r = await callTool(c.access_token, 'jaw_session_status', {});

    const custom = (r.structuredContent.grants as Shown[]).find((g) => g.permissionId === customId)!;
    expect(custom.limits[0].left).toBe('250000');
  });
});
