import type { PermissionState } from '@jaw.id/agent';
import { PERMISSION_MANAGER_ABI } from '@jaw.id/agent';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, maxUint256, type Address, type Hex, type PublicClient } from 'viem';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db/client';
import { grants, payments, settings } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { withFloat } from '@/payments/float-lock';
import { LEASE_MS, PAY_LIMIT_MS } from '@/payments/store';
import { leaks, spoken, toAgent } from '@/test-utils/spoken';
import { disconnect, sweepOnReuse, type DisconnectDeps, type Sent } from './disconnect';
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

describe('jaw_session_disconnect', () => {
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

  it('given a revoke and a return that land, then the owner hears both and the receipt in plain words', async () => {
    const { tenant } = await budgetConnection(async () => approved);
    const { deps } = fakes();

    const result = await disconnect(tenant, deps);

    const [said, receipt] = spoken(result).split('\n');
    expect(said).toBe('Disconnected. Revoked 1 permission and returned 0.4975 USDC to the wallet.');
    expect(receipt).toBe(`Receipt: https://sepolia.basescan.org/tx/${TX}`);
    expect(leaks(spoken(result))).toEqual([]);
    expect(toAgent(result)).toEqual([]);
  });

  it('given a spend limit the fee cannot revoke, then the owner hears it stays approved and the agent how to revoke it', async () => {
    const { tenant } = await budgetConnection(async () => approved);
    const { deps } = fakes({ float: 2_500n, expected: 2_000n, max: 10_000n, sent: { status: 'reverted' } });

    const result = await disconnect(tenant, deps);

    expect(spoken(result)).toContain(
      '1 permission stays approved until it expires, because the fee to revoke it could not be paid. Nothing can use it now that this app is disconnected.'
    );
    expect(spoken(result).split('\n')[0]).toBe('Disconnected.');
    expect(spoken(result)).not.toContain('Nothing was left to revoke or return.');
    expect(leaks(spoken(result))).toEqual([]);
    expect(toAgent(result)).toEqual([
      'For the agent: The owner can revoke the remaining ones in the wallet, or with jaw_revoke_permission after reconnecting; their ids are in stillApproved and unread.',
    ]);
  });

  it('given two live budgets, revokes both in the one batch that returns the float', async () => {
    const { c, tenant, permissionId, permission } = await budgetConnection(async () => approved);
    const [first] = await getDb().select().from(grants).where(eq(grants.permissionId, permissionId));
    const second = `0x${randomBytes(32).toString('hex')}`;
    await getDb()
      .insert(grants)
      .values({ ...first, permissionId: second, permission: { ...permission, salt: '0x7' }, createdAt: new Date() });
    const { deps, sent } = fakes();

    const result = await disconnect(tenant, deps);

    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    const revokes = sent[0]
      .filter((call) => call.to === MANAGER)
      .map((call) => decodeFunctionData({ abi: PERMISSION_MANAGER_ABI, data: call.data }))
      .map((call) => (call.functionName === 'revokeAsSpender' ? call.args[0].salt : undefined));
    expect(revokes.sort()).toEqual([BigInt(permission.salt), 7n].sort());
    expect(args(sent[0][2]).args).toEqual([c.signer.address, 497_500n]);
    expect(result.structuredContent?.revoked).toEqual(expect.arrayContaining([permissionId, second]));
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await revokedAt(second)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });

  it.each([
    ['is not sent', undefined, 'Nothing was revoked: the transaction could not be sent. Try again.'],
    ['reverts', { status: 'reverted' }, 'Nothing was revoked: the transaction failed. Try again.'],
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

  it('revokes via revoke-only when the float is below the reserve but covers the real fee', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 2_500n, expected: 2_000n, max: 10_000n });
    const result = await disconnect(tenant, deps);
    expect(sent).toHaveLength(1);
    const [revoke, cap] = sent[0];
    expect(revoke.to).toBe(MANAGER);
    expect(args(cap)).toEqual({ functionName: 'approve', args: [PAYMASTER, 2_500n] });
    expect(result.structuredContent).toMatchObject({
      revoked: [permissionId],
      stillApproved: [],
      swept: '0',
      txHash: TX,
      left: '2500',
    });
    expect(result.content[0].text).toContain('too little to return after the fee');
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });

  it('leaves the budget to the owner when the revoke-only also reverts', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 2_500n, expected: 2_000n, max: 10_000n, sent: { status: 'reverted' } });
    const result = await disconnect(tenant, deps);
    expect(sent).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ revoked: [], stillApproved: [permissionId], left: '2500' });
    expect(result.content[0].text).toContain(
      'stays approved until it expires, because the fee to revoke it could not be paid'
    );
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
    expect(spoken(result)).toBe('Disconnected. Nothing was left to revoke or return.');
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });

  it('given a budget the chain cannot read, it revokes the others, returns the float and names the unread one', async () => {
    const { c, tenant, permissionId, permission } = await budgetConnection(async () => approved);
    const [first] = await getDb().select().from(grants).where(eq(grants.permissionId, permissionId));
    const unreadable = `0x${randomBytes(32).toString('hex')}`;
    await getDb()
      .insert(grants)
      .values({
        ...first,
        permissionId: unreadable,
        permission: { ...permission, salt: '0x7' },
        createdAt: new Date(),
      });
    const { deps, sent } = fakes({
      readPermission: async (target) => (target.permissionId === unreadable ? { status: 'unavailable' } : approved),
    });

    const result = await disconnect(tenant, deps);

    expect(result.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0].filter((call) => call.to === MANAGER)).toHaveLength(1);
    expect(args(sent[0][1]).args).toEqual([c.signer.address, 497_500n]);
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId], unread: [unreadable], swept: '497500' });
    expect(result.structuredContent?.summary).toContain('could not be read');
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await revokedAt(unreadable)).toBeNull();
    expect(await listed(c.access_token)).toBe(401);
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

  it('when a client lists the tools, then it is titled for people and keeps its flags', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });

    const { json } = await mcp(reader.access_token, { method: 'tools/list' });

    const tool = json.result.tools.find((t: { name: string }) => t.name === 'jaw_session_disconnect');
    expect(tool.title).toBe('Disconnect this app from the wallet');
    expect(tool.annotations).toEqual({ destructiveHint: true, idempotentHint: true });
  });

  it('is a tool, and keeps the tokens with a fixed refusal when the chain cannot be read', async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const result = await callTool(reader.access_token, 'jaw_session_disconnect', {});
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Nothing was revoked: the chain could not be read. Try again.' }],
    });
    expect(leaks(spoken(result))).toEqual([]);
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
    expect(refused.content[0].text).toBe('Nothing was revoked: the transaction failed. Try again.');
    expect(await revokedAt(permissionId)).toBeNull();
    expect(await listed(c.access_token)).toBe(200);
  });

  it('when the float cannot cover the ceiling and the revoke-only also reverts, then it leaves the budget to the owner', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 15_000n, expected: 5_000n, max: 20_000n, sent: { status: 'reverted' } });

    const result = await disconnect(tenant, deps);

    // Two sends: batch at the reserve, then revoke-only fallback (both revert)
    expect(sent).toHaveLength(2);
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
    expect(spoken(result).split('\n')[0]).toBe('Disconnected.');
    expect(spoken(result)).not.toContain('Nothing was left to revoke or return.');
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });
});

describe('given a reused refresh token while a top-up is in flight', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('when the top-up outlives the call limit but not its lease, then the sweep waits for it and returns the float', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const id = `pay_${randomBytes(8).toString('hex')}`;
    await getDb()
      .insert(payments)
      .values({
        id,
        connectionId: tenant.connectionId,
        idempotencyKey: randomBytes(8).toString('hex'),
        requestHash: 'h',
        permissionId,
        payer: tenant.sessionAddress.toLowerCase(),
        url: 'https://seller.example/x',
        leaseUntil: new Date(Date.now() + LEASE_MS),
        topUpAmount: '105000',
      });
    const { deps, sent } = fakes();
    // Once the sweep is waiting, the local clock jumps past the call limit but stays inside the lease.
    const real = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);

    try {
      const sweeping = sweepOnReuse(tenant.connectionId, tenant.sessionKey(), deps);
      await sleep(200);
      skew = PAY_LIMIT_MS + 10_000;
      await sleep(1_000);
      await getDb()
        .update(payments)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(eq(payments.id, id));
      await sweeping;
    } finally {
      clock.mockRestore();
    }

    expect(sent).toHaveLength(1);
    // 0.5 float less the 0.0025 fee reserve.
    expect(args(sent[0][1]).args).toEqual([c.signer.address, 497_500n]);
    expect(await revokedAt(permissionId)).not.toBeNull();
    expect(await listed(c.access_token)).toBe(401);
  });
});

describe('given a never-delegated payer holding the prefund', () => {
  it('when the prefund covers the realistic fee, then it revokes the budget and sweeps the remainder', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    // 0.028117 USDC free, realistic first-op fee estimate (matching the measured ~0.0094)
    const { deps, sent } = fakes({ float: 28_117n, expected: 10_000n, max: 50_000n });

    const result = await disconnect(tenant, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0][0].to).toBe(MANAGER);
    // margin = ceil(10_000 * 1.25) = 12_500; swept = 28_117 - 12_500
    expect(args(sent[0][1]).args).toEqual([c.signer.address, 15_617n]);
    expect(args(sent[0][2]).args).toEqual([PAYMASTER, 12_500n]);
    expect(result.structuredContent).toMatchObject({ revoked: [permissionId], swept: '15617', txHash: TX });
  });

  it('when the prefund is below the fee reserve but above the real fee, then revoke-only succeeds', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    // 8_000 < reserve of 12_500 but above the measured ~9_400 (the sender mock lands it)
    const { deps, sent } = fakes({ float: 8_000n, expected: 10_000n, max: 50_000n });

    const result = await disconnect(tenant, deps);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(args(sent[0][1])).toEqual({ functionName: 'approve', args: [PAYMASTER, 8_000n] });
    expect(result.structuredContent).toMatchObject({
      revoked: [permissionId],
      stillApproved: [],
      swept: '0',
      txHash: TX,
    });
    expect(result.content[0].text).toContain('too little to return after the fee');
    expect(await listed(c.access_token)).toBe(401);
  });

  it('when the payer holds too little for even the revoke fee, then it answers cleanly', async () => {
    const { c, tenant, permissionId } = await budgetConnection(async () => approved);
    const { deps, sent } = fakes({ float: 500n, expected: 10_000n, max: 50_000n, sent: { status: 'reverted' } });

    const result = await disconnect(tenant, deps);

    expect(sent).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ revoked: [], stillApproved: [permissionId], left: '500' });
    expect(result.content[0].text).toContain(
      'stays approved until it expires, because the fee to revoke it could not be paid'
    );
    expect(await listed(c.access_token)).toBe(401);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a host that ends transactions left idle', () => {
  beforeAll(useTestPostgres);

  it('when disconnect holds the float across two receipt waits, then its hold outlives the host limit', async () => {
    await getDb().execute(
      sql`do $$ begin execute format('alter database %I set idle_in_transaction_session_timeout = %L', current_database(), '1s'); end $$`
    );
    const held = await withFloat('conn_idle', 1_000, async (hold) => {
      await new Promise((r) => setTimeout(r, 1_500));
      hold.assertHeld();
      return true;
    });
    expect(held).toBe(true);
  });
});

describe.skipIf(!TEST_PG_URL)('on Postgres, given a token rotation that holds the connection row', () => {
  beforeAll(useTestPostgres);

  it("when disconnect's final write waits on it past the wait, then it answers busy and the tokens still work", async () => {
    const reader = await connect(undefined, { scope: 'wallet:read' });
    const tenant = (await verifyBearer(reader.access_token))?.extra?.tenant as Tenant;
    const { deps } = fakes({ float: 0n });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const rotation = getDb().transaction(async (tx) => {
      await tx.execute(sql`select id from connections where id = ${tenant.connectionId} for share`);
      held();
      await released;
    });
    await holding;
    try {
      const reply = await Promise.race([
        disconnect(tenant, { ...deps, lockWaitMs: 200 }),
        new Promise((r) => setTimeout(() => r('blocked'), 2_000)),
      ]);
      expect(JSON.stringify(reply)).toContain('A payment on this connection is in progress');
      expect(await listed(reader.access_token)).toBe(200);
    } finally {
      release();
      await rotation;
    }
  });
});
