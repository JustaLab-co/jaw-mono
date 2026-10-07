import { randomBytes } from 'node:crypto';
import type { ChainClients } from '@jaw.id/agent';
import { eq, inArray } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { connect, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { auditEvents, payments } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { render } from '@/payments/render';
import { purge, reconcile } from './run';

setTestEnv();
process.env.JAW_MCP_CRON_SECRET = 'cron-secret';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const AUTHORIZATION_USED = parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);
const hex32 = () => `0x${randomBytes(32).toString('hex')}` as Hex;

const used = new Map<string, Hex>();
const unreadable = new Set<string>();
const asked: string[] = [];
let payer: Address;

const node = {
  readContract: async ({ args }: { args: [Address, Hex] }) => {
    const nonce = args[1].toLowerCase();
    asked.push(nonce);
    if (unreadable.has(nonce)) throw new Error('node down');
    return used.has(nonce);
  },
  getBlockNumber: async () => 5_000n,
  getLogs: async ({ args }: { args: { nonce: Hex } }) => {
    const tx = used.get(args.nonce.toLowerCase());
    return tx ? [{ transactionHash: tx }] : [];
  },
  waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    const nonce = [...used].find(([, tx]) => tx === hash)?.[0];
    if (!nonce) throw new Error('no receipt');
    return {
      status: 'success',
      blockNumber: 4_990n,
      logs: [
        {
          address: USDC,
          topics: encodeEventTopics({
            abi: AUTHORIZATION_USED,
            eventName: 'AuthorizationUsed',
            args: { authorizer: payer, nonce: nonce as Hex },
          }),
          data: encodeAbiParameters([], []),
        },
      ],
    };
  },
  getBlock: async () => ({ number: 5_000n, timestamp: 1_790_000_000n }),
};
const clients: ChainClients = { publicClient: () => node as unknown as PublicClient };

let t: Tenant;
beforeAll(async () => {
  await useTestDb();
  const c = await connect();
  t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  payer = t.sessionAddress;
});
beforeEach(() => {
  used.clear();
  unreadable.clear();
  asked.length = 0;
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function signedRow(
  over: { deadline?: Date; signedAt?: Date; state?: 'signed' | 'unknown'; txHash?: Hex; leaseUntil?: Date } = {}
) {
  const id = `pay_${randomBytes(8).toString('hex')}`;
  const nonce = hex32();
  await getDb()
    .insert(payments)
    .values({
      id,
      connectionId: t.connectionId,
      idempotencyKey: id,
      requestHash: 'h',
      permissionId: '0xgrant',
      payer: payer.toLowerCase(),
      url: 'https://seller.example/x',
      state: over.state ?? 'signed',
      leaseUntil: over.leaseUntil ?? minutesAgo(1),
      kind: 'failed',
      code: 'no_response',
      topUpAmount: '105000',
      scheme: 'exact',
      network: 'eip155:84532',
      asset: USDC,
      payTo: '0x2222222222222222222222222222222222222222',
      nonce,
      authorized: '5000',
      deadline: over.deadline ?? minutesAgo(10),
      authorization: { nonce },
      signedAt: over.signedAt ?? minutesAgo(10),
      txHash: over.txHash,
    });
  return { id, nonce };
}

const rowOf = async (id: string) => (await getDb().select().from(payments).where(eq(payments.id, id)))[0];

describe('reconciler', () => {
  it('settles a used nonce with the transaction that used it, and fails an expired unused one', async () => {
    const paid = await signedRow();
    const lapsed = await signedRow({ state: 'unknown' });
    used.set(paid.nonce, hex32());

    expect(await reconcile(clients)).toMatchObject({ settled: 1, failed: 1 });
    expect(await rowOf(paid.id)).toMatchObject({
      state: 'settled',
      txHash: used.get(paid.nonce),
      amount: '5000',
      blockTime: new Date(1_790_000_000_000),
    });
    expect(await rowOf(lapsed.id)).toMatchObject({ state: 'failed', finishedAt: expect.any(Date) });
  });

  it('settles a payment whose answer was lost as paid, keeping the refill it needed', async () => {
    const lost = await signedRow();
    used.set(lost.nonce, hex32());
    await reconcile(clients);
    const row = await rowOf(lost.id);
    expect(row).toMatchObject({ state: 'settled', kind: 'paid', code: null });
    expect(render(row, []).structuredContent).toMatchObject({
      kind: 'paid',
      moneyMoved: true,
      topUp: { amount: '105000' },
    });
  });

  it('does not record a transaction hash another payment of the payer already settled on', async () => {
    const first = await signedRow();
    const second = await signedRow({ deadline: new Date(Date.now() + 60_000) });
    const shared = hex32();
    used.set(first.nonce, shared);
    await reconcile(clients);
    used.set(second.nonce, shared);
    await getDb().update(payments).set({ reconcilingUntil: null }).where(eq(payments.id, second.id));
    await reconcile(clients);
    expect(await rowOf(first.id)).toMatchObject({ state: 'settled', txHash: shared });
    expect(await rowOf(second.id)).toMatchObject({ state: 'settled', txHash: null, amount: '5000' });
  });

  it('leaves a row alone while the call that signed it may still be running', async () => {
    const live = await signedRow({ leaseUntil: new Date(Date.now() + 60_000) });
    used.set(live.nonce, hex32());
    await reconcile(clients);
    expect(asked).not.toContain(live.nonce);
    expect((await rowOf(live.id)).state).toBe('signed');
  });

  it('leaves an unused nonce still inside its deadline, and a row the node cannot read, open', async () => {
    const live = await signedRow({ deadline: new Date(Date.now() + 60_000) });
    const dark = await signedRow();
    unreadable.add(dark.nonce);
    const report = await reconcile(clients);
    expect(report.open).toBeGreaterThanOrEqual(2);
    expect((await rowOf(live.id)).state).toBe('signed');
    expect((await rowOf(dark.id)).state).toBe('signed');
  });

  it('never selects a row younger than the window, nor a terminal one', async () => {
    const young = await signedRow({ signedAt: new Date() });
    const done = await signedRow();
    used.set(done.nonce, hex32());
    await reconcile(clients);
    asked.length = 0;
    await reconcile(clients);
    expect(asked).not.toContain(young.nonce);
    expect(asked).not.toContain(done.nonce);
    expect((await rowOf(done.id)).state).toBe('settled');
  });

  it('answers each row once when two runs start together', async () => {
    const rows = await Promise.all([signedRow(), signedRow(), signedRow()]);
    for (const r of rows) used.set(r.nonce, hex32());
    await Promise.all([reconcile(clients), reconcile(clients)]);
    for (const r of rows) expect(asked.filter((n) => n === r.nonce)).toHaveLength(1);
    const states = await getDb()
      .select({ state: payments.state })
      .from(payments)
      .where(
        inArray(
          payments.id,
          rows.map((r) => r.id)
        )
      );
    expect(states.every((s) => s.state === 'settled')).toBe(true);
  });

  it('raises one alert for a row unanswered an hour past its deadline', async () => {
    const stuck = await signedRow({ deadline: minutesAgo(90), signedAt: minutesAgo(100) });
    unreadable.add(stuck.nonce);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await reconcile(clients);
      await reconcile(clients);
      const alerts = logged.mock.calls.filter(([line]) => String(line).includes(stuck.id));
      expect(alerts).toHaveLength(1);
      expect((await rowOf(stuck.id)).alertedAt).toEqual(expect.any(Date));
    } finally {
      logged.mockRestore();
      unreadable.clear();
      await reconcile(clients);
    }
  });

  it('purges expired OAuth state and keeps every payment', async () => {
    const kept = await signedRow({ deadline: new Date(Date.now() + 60_000) });
    await purge();
    expect(await rowOf(kept.id)).toBeDefined();
  });
});

describe('audit retention', () => {
  it('purges audit events older than ninety days and keeps recent ones', async () => {
    const c = await connect();
    const { connectionId } = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const day = 24 * 60 * 60 * 1000;
    await getDb()
      .insert(auditEvents)
      .values([
        { connectionId, tool: 'old', outcome: 'ok', createdAt: new Date(Date.now() - 91 * day) },
        { connectionId, tool: 'recent', outcome: 'ok', createdAt: new Date(Date.now() - 89 * day) },
      ]);
    await purge();
    const left = await getDb().select().from(auditEvents).where(eq(auditEvents.connectionId, connectionId));
    expect(left.map((e) => e.tool)).toEqual(['recent']);
  });
});

describe('cron and metrics routes', () => {
  const call = async (path: 'cron' | 'metrics', secret?: string) => {
    const mod =
      path === 'cron' ? await import('@/app/api/cron/reconcile/route') : await import('@/app/api/metrics/route');
    const req = new Request(`http://mcp.test/api/${path}`, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    return mod.GET(req, { params: Promise.resolve({}) });
  };

  it.each(['cron', 'metrics'] as const)('refuses /api/%s without the secret', async (path) => {
    expect((await call(path)).status).toBe(401);
    expect((await call(path, 'wrong-secret')).status).toBe(401);
  });

  it('serves payments by state and the backlog with the secret', async () => {
    await signedRow({ deadline: new Date(Date.now() + 60_000) });
    const res = await call('metrics', 'cron-secret');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/^jaw_mcp_payments\{state="signed"\} \d+$/m);
    expect(text).toMatch(/^jaw_mcp_payments_backlog [1-9]\d*$/m);
  });
});
