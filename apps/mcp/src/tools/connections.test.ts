import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, owner, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, permissionRequests } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { x402Budget } from '@/grants/store';

setTestEnv();
beforeAll(useTestDb);

const tenantOf = async (token: string) => (await verifyBearer(token))?.extra?.tenant as Tenant;

interface Listed {
  id: string;
  current: boolean;
  grants: { permissionId: string; kind: string; status: string; spends: object[]; expiresAt: string }[];
}

describe('jaw_connections', () => {
  it("lists every connection of this account with its grants by permissionId, marks this one, and no other account's", async () => {
    const signer = owner();
    const paying = await connect(signer, { scope: 'wallet:read x402:pay' });
    const reading = await connect(signer, { scope: 'wallet:read' });
    await connect(owner());
    const [payingId, readingId] = [
      (await tenantOf(paying.access_token)).connectionId,
      (await tenantOf(reading.access_token)).connectionId,
    ];
    const budget = (await x402Budget(payingId))!;

    const result = await callTool(reading.access_token, 'jaw_connections', {});
    const listed = result.structuredContent.connections as Listed[];

    expect(listed.map((c) => c.id).sort()).toEqual([payingId, readingId].sort());
    expect(listed.find((c) => c.id === readingId)).toMatchObject({ current: true, grants: [] });
    expect(listed.find((c) => c.id === payingId)).toMatchObject({
      current: false,
      grants: [
        {
          permissionId: budget.permissionId,
          kind: 'x402-budget',
          status: 'live',
          spends: [{ token: budget.token, allowance: '1000000', unit: 'day', multiplier: 1 }],
          expiresAt: budget.expiresAt.toISOString(),
        },
      ],
    });
  });

  it('given a grant revoked on chain, then it is listed revoked and not counted live', async () => {
    const c = await connect();
    const t = await tenantOf(c.access_token);
    const budget = (await x402Budget(t.connectionId))!;
    await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, budget.permissionId));

    const result = await callTool(c.access_token, 'jaw_connections', {});

    expect((result.structuredContent.connections as Listed[])[0].grants).toMatchObject([{ status: 'revoked' }]);
    expect(result.structuredContent.summary).toContain('0 live grant(s)');
  });

  it('given a grant the wallet answered but this server did not record, then its id is listed as unrecorded', async () => {
    const c = await connect();
    const t = await tenantOf(c.access_token);
    const budget = (await x402Budget(t.connectionId))!;
    const orphan = `0x${'ab'.repeat(32)}`;
    const request = (id: string, permissionId: string, state: 'failed' | 'approved') => ({
      id,
      connectionId: t.connectionId,
      method: 'grant' as const,
      chainId: t.chainId,
      account: t.account,
      permissionId,
      state,
      walletUrl: 'http://keys.test/cli-bridge',
      approveBy: new Date(),
    });
    await getDb()
      .insert(permissionRequests)
      .values([
        { ...request(`pr_${t.connectionId}_a`, orphan, 'failed'), code: 'not_recorded' },
        request(`pr_${t.connectionId}_b`, budget.permissionId, 'approved'),
      ]);

    const result = await callTool(c.access_token, 'jaw_connections', {});

    expect((result.structuredContent.connections as { unrecorded: string[] }[])[0].unrecorded).toEqual([orphan]);
  });
});
