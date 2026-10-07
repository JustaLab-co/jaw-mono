import type { PermissionState } from '@jaw.id/agent';
import { PERMISSION_MANAGER_ABI } from '@jaw.id/agent';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { grants, payments, settings } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { disconnect, type DisconnectDeps } from './disconnect';
import { budgetConnection, callTool, connect, mcp, setTestEnv } from './testkit';
import { verifyBearer, type Tenant } from './auth';

setTestEnv();
beforeAll(useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MANAGER = '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8';
const TX = `0x${'ab'.repeat(32)}` as Hex;
const approved: PermissionState = { status: 'ok', approved: true, revoked: false };

function fakes(over: Partial<DisconnectDeps> & { float?: bigint } = {}) {
  const sent: { to: Address; data: Hex }[][] = [];
  const deps: DisconnectDeps = {
    readPermission: async () => approved,
    readFloat: async () => over.float ?? 500_000n,
    send: async (_t, calls) => {
      sent.push(calls);
      return TX;
    },
    ...over,
  };
  return { deps, sent };
}

const listed = async (token: string) => (await mcp(token, { method: 'tools/list' })).status;
const revokedAt = async (permissionId: string) =>
  (await getDb().select().from(grants).where(eq(grants.permissionId, permissionId)))[0].revokedAt;

async function holdPayment(t: Tenant, permissionId: string, reserved: string) {
  await getDb()
    .insert(payments)
    .values({
      id: `pay_${randomBytes(8).toString('hex')}`,
      connectionId: t.connectionId,
      idempotencyKey: randomBytes(8).toString('hex'),
      requestHash: 'h',
      permissionId,
      payer: t.sessionAddress.toLowerCase(),
      url: 'https://seller.example/x',
      leaseUntil: new Date(Date.now() + 60_000),
      reserved,
    });
}

describe('jaw_disconnect', () => {
  it('revokes the budget as spender, returns the float less what payments hold to the owner, then ends the tokens', async () => {
    const { c, tenant, permissionId, permission } = await budgetConnection(async () => approved);
    await holdPayment(tenant, permissionId, '20000');
    const { deps, sent } = fakes();

    const result = await disconnect(tenant, deps);

    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    const [revoke, sweep] = sent[0];
    expect(revoke.to).toBe(MANAGER);
    const call = decodeFunctionData({ abi: PERMISSION_MANAGER_ABI, data: revoke.data });
    expect(call.functionName).toBe('revokeAsSpender');
    expect(call.args[0]).toMatchObject({ account: permission.account, spender: permission.spender });
    expect(sweep.to).toBe(USDC);
    // 0.5 float, 0.02 held by a pending payment, 0.01 kept for the batch's own fee.
    expect(decodeFunctionData({ abi: erc20Abi, data: sweep.data }).args).toEqual([c.signer.address, 470_000n]);
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId], swept: '470000', txHash: TX });

    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });

  it('revokes nothing when the chain step fails, so a retry completes it', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const failing = fakes({ send: async () => Promise.reject(new Error('bundler said no, key 0xsecret')) });

    const refused = await disconnect(tenant, failing.deps);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe('Nothing was revoked: the transaction did not go through. Try again.');
    expect(await revokedAt(permissionId)).toBeNull();
    expect(await listed(c.access_token)).toBe(200);

    const retried = await disconnect(tenant, fakes().deps);
    expect(retried.isError).toBeFalsy();
    expect(await listed(c.access_token)).toBe(401);
  });

  it('sends nothing when the chain shows the budget revoked and the payer holds less than a fee', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({
      float: 5_000n,
      readPermission: async () => ({ status: 'ok', approved: true, revoked: true }),
    });

    const result = await disconnect(tenant, deps);

    expect(sent).toEqual([]);
    expect(result.structuredContent).toMatchObject({ revoked: [], swept: '0', txHash: null, left: '5000' });
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });

  it('refuses while the chain cannot say whether a budget is live, and revokes nothing', async () => {
    const { c, tenant } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ readPermission: async () => ({ status: 'unavailable' }) });

    expect((await disconnect(tenant, deps)).isError).toBe(true);
    expect(sent).toEqual([]);
    expect(await listed(c.access_token)).toBe(200);
  });

  it('disconnects a read-only connection without touching the chain', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const tenant = (await verifyBearer(reader.access_token))?.extra?.tenant as Tenant;
    const { deps, sent } = fakes();

    expect((await disconnect(tenant, deps)).isError).toBeFalsy();
    expect(sent).toEqual([]);
    expect(await listed(reader.access_token)).toBe(401);
  });

  it('refuses while payments are paused', async () => {
    const { c, tenant } = await budgetConnection(async () => approved);
    await getDb().insert(settings).values({ key: 'payments_paused', value: true });
    try {
      const { deps, sent } = fakes();
      expect((await disconnect(tenant, deps)).isError).toBe(true);
      expect(sent).toEqual([]);
      expect(await listed(c.access_token)).toBe(200);
    } finally {
      await getDb().delete(settings).where(eq(settings.key, 'payments_paused'));
    }
  });

  it('is a tool the agent can call', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const result = await callTool(reader.access_token, 'jaw_disconnect', {});
    expect(result.isError).toBeFalsy();
    expect(await listed(reader.access_token)).toBe(401);
  });
});
