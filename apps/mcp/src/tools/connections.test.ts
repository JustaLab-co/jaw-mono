import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { grantBudget, callTool, connect, mcp, owner, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, permissionRequests } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { leaks, spoken, toAgent } from '@/test-utils/spoken';

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
    const budget = (await grantBudget(await tenantOf(paying.access_token), signer))!;

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
    const signer = owner();
    const c = await connect(signer);
    const t = await tenantOf(c.access_token);
    const budget = (await grantBudget(t, signer))!;
    await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, budget.permissionId));

    const result = await callTool(c.access_token, 'jaw_connections', {});

    expect((result.structuredContent.connections as Listed[])[0].grants).toMatchObject([{ status: 'revoked' }]);
    expect(result.structuredContent.summary).toContain('0 permissions in force');
  });

  it('given one app with its spend limit live, then the owner hears how many apps and permissions there are, in plain words', async () => {
    const signer = owner();
    const c = await connect(signer);
    await grantBudget(await tenantOf(c.access_token), signer);

    const result = await callTool(c.access_token, 'jaw_connections', {});

    expect(spoken(result)).toBe('1 app connected, 1 permission in force.');
    expect(leaks(spoken(result))).toEqual([]);
    expect(toAgent(result)).toEqual(['For the agent: jaw_revoke_permission takes a permissionId from here.']);
  });

  it('given a replaced spend limit still approved on chain, then the owner hears it in plain words and the agent gets its id', async () => {
    const signer = owner();
    const c = await connect(signer);
    const t = await tenantOf(c.access_token);
    const first = (await grantBudget(t, signer))!;
    await grantBudget(t, signer);
    await getDb().update(grants).set({ replacedAt: new Date() }).where(eq(grants.permissionId, first.permissionId));

    const result = await callTool(c.access_token, 'jaw_connections', {});

    expect(spoken(result)).toBe(
      '1 app connected, 1 permission in force. 1 replaced spend limit is still approved on chain until it expires.'
    );
    expect(leaks(spoken(result))).toEqual([]);
    expect(toAgent(result)).toEqual([
      `For the agent: jaw_revoke_permission takes a permissionId from here; the replaced ones are ${first.permissionId}.`,
    ]);
  });

  it('when a client lists the tools, then it is titled for people and stays read-only', async () => {
    const c = await connect();

    const { json } = await mcp(c.access_token, { method: 'tools/list' });

    const tool = json.result.tools.find((t: { name: string }) => t.name === 'jaw_connections');
    expect(tool.title).toBe('Apps connected to the wallet');
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it('given a grant the wallet answered but this server did not record, then its id is listed as unrecorded', async () => {
    const signer = owner();
    const c = await connect(signer);
    const t = await tenantOf(c.access_token);
    const budget = (await grantBudget(t, signer))!;
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
