import type { PermissionState } from '@jaw.id/agent';
import { PERMISSION_MANAGER_ABI } from '@jaw.id/agent';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, maxUint256, type Address, type Hex, type PublicClient } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db/client';
import { grants, payments, settings } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { lockFloat } from '@/payments/refill';
import { disconnect, type DisconnectDeps, type Sent } from './disconnect';
import { budgetConnection, callTool, connect, mcp, setTestEnv } from './testkit';
import { verifyBearer, type Tenant } from './auth';

setTestEnv();
process.env.JAW_MCP_RPC_URL = 'http://127.0.0.1:9';
beforeAll(useTestDb);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MANAGER = '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8';
const TX = `0x${'ab'.repeat(32)}` as Hex;
const PAYMASTER = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';
const approved: PermissionState = { status: 'ok', approved: true, revoked: false };

type Call = { to: Address; data: Hex };

function fakes(
  over: {
    float?: bigint;
    expected?: bigint;
    max?: bigint;
    sent?: Sent | Sent[];
    readPermission?: DisconnectDeps['readPermission'];
  } = {}
) {
  const sent: Call[][] = [];
  const quoted: Call[][] = [];
  const outcomes = [over.sent ?? { status: 'landed', txHash: TX }].flat();
  const node = {
    getBlockNumber: async () => 100n,
    readContract: async () => over.float ?? 500_000n,
  } as unknown as PublicClient;
  const deps: DisconnectDeps = {
    readPermission: over.readPermission ?? (async () => approved),
    clients: { publicClient: () => node },
    sender: async () => ({
      paymaster: PAYMASTER,
      quote: async (calls) => {
        quoted.push(calls);
        return { expected: over.expected ?? 2_000n, max: over.max ?? 10_000n };
      },
      send: async (calls) => {
        sent.push(calls);
        return outcomes[Math.min(sent.length, outcomes.length) - 1];
      },
    }),
  };
  return { deps, sent, quoted };
}

const args = (call: Call) => decodeFunctionData({ abi: erc20Abi, data: call.data });

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
    const { deps, sent, quoted } = fakes();

    const result = await disconnect(tenant, deps);

    expect(result.isError).toBeFalsy();
    expect(args(quoted[0][1]).args).toEqual([c.signer.address, 1n]);
    expect(sent).toHaveLength(1);
    const [revoke, sweep, cap] = sent[0];
    expect(revoke.to).toBe(MANAGER);
    const call = decodeFunctionData({ abi: PERMISSION_MANAGER_ABI, data: revoke.data });
    expect(call.functionName).toBe('revokeAsSpender');
    expect(call.args[0]).toMatchObject({ account: permission.account, spender: permission.spender });
    expect(sweep.to).toBe(USDC);
    // 0.5 float, 0.02 held by a pending payment, 0.0025 reserved for the batch's own fee.
    expect(args(sweep).args).toEqual([c.signer.address, 477_500n]);
    // The most the payer can lose to the fee is the reserve, whatever the fee turns out to be.
    expect(args(cap)).toEqual({ functionName: 'approve', args: [PAYMASTER, 2_500n] });
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId], swept: '477500', txHash: TX });

    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });

  it.each([
    ['is not sent', undefined, 'Nothing was revoked: the transaction could not be sent. Try again.'],
    ['reverts', { status: 'reverted' }, 'Nothing was revoked: the transaction reverted. Try again.'],
    ['is not confirmed in time', { status: 'unconfirmed' }, 'The transaction was sent but is not confirmed yet.'],
  ] as const)('ends nothing when the batch %s, so a retry completes it', async (_name, outcome, text) => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const failing = fakes({ sent: outcome });
    if (!outcome) {
      failing.deps.sender = async () => ({
        paymaster: PAYMASTER,
        quote: async () => ({ expected: 2_000n, max: 10_000n }),
        send: async () => Promise.reject(new Error('bundler said no, key 0xsecret')),
      });
    }

    const refused = await disconnect(tenant, failing.deps);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text.startsWith(text)).toBe(true);
    expect(await revokedAt(permissionId)).toBeNull();
    expect(await listed(c.access_token)).toBe(200);

    const retried = await disconnect(tenant, fakes().deps);
    expect(retried.isError).toBeFalsy();
    expect(await listed(c.access_token)).toBe(401);
  });

  it('decides from the budgets, not the token, so a token narrowed to wallet:read still returns the float', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes();
    const result = await disconnect({ ...tenant, scopes: ['wallet:read'] }, deps);
    expect(sent).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId] });
    expect(await listed(c.access_token)).toBe(401);
  });

  it('leaves the budget to the owner when the float cannot pay the reserve, and still ends the tokens', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 2_500n, expected: 2_000n, max: 10_000n });
    const result = await disconnect(tenant, deps);
    expect(sent).toEqual([]);
    expect(result.structuredContent).toMatchObject({ revoked: [], stillApproved: [permissionId], left: '2500' });
    expect(result.content[0].text).toContain('http://keys.test/connections');
    expect(await revokedAt(permissionId)).toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });

  it('sends nothing when the chain shows the budget revoked and the payer is empty', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({
      float: 0n,
      readPermission: async () => ({ status: 'ok', approved: true, revoked: true }),
    });

    const result = await disconnect(tenant, deps);

    expect(sent).toEqual([]);
    expect(result.structuredContent).toMatchObject({ revoked: [], swept: '0', txHash: null, left: '0' });
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

  it('disconnects a read-only connection without sending anything', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const tenant = (await verifyBearer(reader.access_token))?.extra?.tenant as Tenant;
    const { deps, sent } = fakes({ float: 0n });

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

  it('is a tool, and keeps the tokens with a fixed refusal when the chain cannot be read', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const result = await callTool(reader.access_token, 'jaw_disconnect', {});
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Nothing was revoked: the chain could not be read. Try again.' }],
    });
    expect(await listed(reader.access_token)).toBe(200);
  });
});

describe('given a funded payer with nothing held and a live budget', () => {
  it('when the agent disconnects, then it returns the float less the expected fee with a margin', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent, quoted } = fakes({ float: 30_000n, expected: 5_000n, max: 20_000n });

    const result = await disconnect(tenant, deps);

    // 1.25 x 5000 reserved, against the 20000 ceiling kept before.
    expect(args(sent[0][1]).args).toEqual([c.signer.address, 23_750n]);
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId], swept: '23750', txHash: TX });
    expect(quoted[0].map((call) => call.to)).toEqual([MANAGER, USDC, USDC]);
    expect(await listed(c.access_token)).toBe(401);
  });

  it('when the reserve is set, then the fee amounts are logged as fields', async () => {
    const { tenant } = await budgetConnection(async () => approved);
    const { deps } = fakes({ float: 30_000n, expected: 5_000n, max: 20_000n });
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => logged.push(JSON.parse(String(line))));

    try {
      await disconnect(tenant, deps);
    } finally {
      spy.mockRestore();
    }

    expect(logged).toContainEqual(
      expect.objectContaining({
        msg: 'disconnect fee reserve',
        fee: { expected: '5000', reserve: '6250', max: '20000' },
      })
    );
  });

  it('when the fee is quoted, then the quoted batch leaves the paymaster room for any fee', async () => {
    const { tenant } = await budgetConnection(async () => approved);
    const { deps, quoted } = fakes({ float: 30_000n });

    await disconnect(tenant, deps);

    // The bundler runs the paymaster's postOp while it estimates; a small cap there fails the quote.
    expect(args(quoted[0][2])).toEqual({ functionName: 'approve', args: [PAYMASTER, maxUint256] });
  });

  it('when the agent disconnects, then the last call caps what the paymaster can take at the reserve', async () => {
    const { tenant } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 30_000n, expected: 5_001n, max: 20_000n });

    await disconnect(tenant, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(3);
    // Rounded up, so the reserve is never below 1.25 x the expected fee.
    expect(args(sent[0][2])).toEqual({ functionName: 'approve', args: [PAYMASTER, 6_252n] });
  });

  it('when the margin would pass the ceiling, then it never reserves more than the ceiling', async () => {
    const { c, tenant } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 30_000n, expected: 10_000n, max: 11_000n });

    await disconnect(tenant, deps);

    expect(args(sent[0][1]).args).toEqual([c.signer.address, 19_000n]);
    expect(args(sent[0][2]).args).toEqual([PAYMASTER, 11_000n]);
  });

  it('when the float covers the reserve but not the ceiling, then it still revokes and returns it', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 2_501n, expected: 2_000n, max: 10_000n });

    const result = await disconnect(tenant, deps);

    expect(args(sent[0][1]).args).toEqual([c.signer.address, 1n]);
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId], stillApproved: [] });
  });
});

describe('given the fee rises above the reserve before the batch lands', () => {
  it('when the batch reverts, then it retries once at the ceiling and completes', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({
      float: 30_000n,
      expected: 5_000n,
      max: 20_000n,
      sent: [{ status: 'reverted' }, { status: 'landed', txHash: TX }],
    });

    const result = await disconnect(tenant, deps);

    expect(sent).toHaveLength(2);
    expect(args(sent[1][1]).args).toEqual([c.signer.address, 10_000n]);
    expect(args(sent[1][2]).args).toEqual([PAYMASTER, 20_000n]);
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId], swept: '10000', txHash: TX });
    expect(await listed(c.access_token)).toBe(401);
  });

  it('when the retry at the ceiling reverts too, then nothing is revoked and the token still works', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 30_000n, expected: 5_000n, max: 20_000n, sent: { status: 'reverted' } });

    const refused = await disconnect(tenant, deps);

    expect(sent).toHaveLength(2);
    expect(refused.content[0].text).toBe('Nothing was revoked: the transaction reverted. Try again.');
    expect(await revokedAt(permissionId)).toBeNull();
    expect(await listed(c.access_token)).toBe(200);
  });

  it('when the float cannot cover the ceiling, then it leaves the budget to the owner and still ends the tokens', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 15_000n, expected: 5_000n, max: 20_000n, sent: { status: 'reverted' } });

    const result = await disconnect(tenant, deps);

    expect(sent).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ revoked: [], stillApproved: [permissionId], left: '15000' });
    expect(await revokedAt(permissionId)).toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });
});

describe('given the batch landed but its reply was lost', () => {
  it('when the agent calls again, then it sends nothing for the residual and ends the connection', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({
      float: 1_800n,
      readPermission: async () => ({ status: 'ok', approved: true, revoked: true }),
    });

    const result = await disconnect(tenant, deps);

    expect(sent).toEqual([]);
    expect(result.structuredContent).toMatchObject({ revoked: [], stillApproved: [], swept: '0', left: '1800' });
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });
});

describe('given a host that ends transactions left idle', () => {
  it('when disconnect holds the float lock across two receipt waits, then its transaction outlives them', async () => {
    const setting = await getDb().transaction(async (tx) => {
      await lockFloat(tx, 'conn_idle', 1_000);
      const { rows } = (await tx.execute(
        sql`select current_setting('idle_in_transaction_session_timeout') as idle`
      )) as unknown as { rows: { idle: string }[] };
      return rows[0].idle;
    });

    // Two 60 s receipt waits plus the quote, with room to spare.
    expect(setting).toBe('5min');
  });
});
