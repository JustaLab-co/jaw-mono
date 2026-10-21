import { createHash, randomBytes } from 'node:crypto';
import type { ChainClients, PermissionState } from '@jaw.id/agent';
import { and, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { PERMISSION_MANAGER_ABI, usdcForNetwork } from '@jaw.id/agent';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import {
  approvedOnChain,
  Browser,
  connect,
  fakeWallet,
  follow,
  owner,
  sessionFakes,
  setTestEnv,
  setWallet,
  startAuthorization,
  token,
  verifyLocally,
  walletAnswers,
  walletsSettled,
  ISSUER,
} from '@/connections/testkit';
import { takeSealedKey } from '@/connections/rows';
import { spends } from '@/connections/scopes';
import { getDb } from '@/db/client';
import { auditEvents, connections, grants, oauthPayloads, ownerCalls, payments } from '@/db/schema';
import { useTestDb, withoutOwnerCallsGuard } from '@/db/test-db';
import { budgetGrant, checkGranted, recordGrant } from '@/grants/permission';
import { fakeChain, type FakeEvent } from '@/owner-calls/chain-testkit';
import type { ReadReceipt } from '@/owner-calls/receipt';
import { decline, insertOwnerCall, markSent, markSendStarted } from '@/owner-calls/store';
import { sendCallsStatus } from '@/tools/owner-calls';
import { render } from '@/payments/render';
import { recordRevoked } from '@/grants/store';
import { purge, reconcile, RECONCILE_AFTER_MS, sweepRevokedGrants } from './run';

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
      payerRefilled: true,
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

  it('refuses a second payment of the payer holding the same transaction hash, in any case', async () => {
    const hash = hex32();
    await signedRow({ txHash: hash });
    await expect(signedRow({ txHash: `0x${hash.slice(2).toUpperCase()}` })).rejects.toThrow();
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

  it('asks the chain about an open row once per claim, however often it runs', async () => {
    const open = await signedRow({ deadline: new Date(Date.now() + 60_000) });
    await reconcile(clients);
    await reconcile(clients);
    expect(asked.filter((n) => n === open.nonce)).toHaveLength(1);
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

const CALLS_ID = `0x${'cd'.repeat(32)}`;
const MINED = `0x${'ab'.repeat(32)}`;
const noWallet = async () => {
  throw new Error('no wallet in this test');
};

async function openCall() {
  const row = await insertOwnerCall({
    connectionId: t.connectionId,
    key: randomBytes(8).toString('hex'),
    requestHash: 'h',
    chainId: t.chainId,
    account: t.account,
    calls: [{ to: '0x2222222222222222222222222222222222222222', data: '0xa9059cbb', value: '0' }],
    walletUrl: 'https://keys.test/cli-bridge#x',
    approveBy: new Date(Date.now() + 600_000),
  });
  return row!.id;
}

/** A sent owner call, `age` ms past its last write on the database clock. */
async function sentCall(age: number, callsId: string = CALLS_ID) {
  const id = await openCall();
  await markSent(t.connectionId, id, callsId);
  await ageCall(id, age);
  return id;
}

const ageCall = (id: string, age: number) =>
  withoutOwnerCallsGuard(() =>
    getDb().execute(
      sql`update owner_calls set updated_at = statement_timestamp() - ${age} * interval '1 millisecond' where id = ${id}`
    )
  );

const callOf = async (id: string) => (await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, id)))[0];
const OLD = RECONCILE_AFTER_MS + 1_000;
const receiptFor = (answers: Record<string, Awaited<ReturnType<ReadReceipt>> | Error>): ReadReceipt =>
  vi.fn(async (_chain, id) => {
    const a = answers[id];
    if (a instanceof Error) throw a;
    return a ?? null;
  });

describe('sent owner calls', () => {
  beforeEach(() => withoutOwnerCallsGuard(() => getDb().delete(ownerCalls)));

  it('concludes a sent call whose receipt succeeded as landed with the transaction', async () => {
    const id = await sentCall(OLD);
    const report = await reconcile(clients, new Date(), receiptFor({ [CALLS_ID]: { success: true, txHash: MINED } }));
    expect(await callOf(id)).toMatchObject({ state: 'landed', txHash: MINED });
    expect(report.ownerCalls).toEqual({ landed: 1, reverted: 0, open: 0 });
  });

  it('concludes a sent call whose receipt failed as reverted', async () => {
    const id = await sentCall(OLD);
    const report = await reconcile(clients, new Date(), receiptFor({ [CALLS_ID]: { success: false, txHash: MINED } }));
    expect(await callOf(id)).toMatchObject({ state: 'reverted', txHash: MINED });
    expect(report.ownerCalls).toEqual({ landed: 0, reverted: 1, open: 0 });
  });

  it('keeps a call sent while the bundler has no receipt', async () => {
    const id = await sentCall(OLD);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = await reconcile(clients, new Date(), receiptFor({}));
      expect(await callOf(id)).toMatchObject({ state: 'sent', txHash: null });
      expect(report.ownerCalls.open).toBe(1);
      expect(logged.mock.calls.filter(([line]) => String(line).includes(id))).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it('logs and skips a receipt it cannot read, and still concludes the others', async () => {
    const down = await sentCall(OLD, `0x${'01'.repeat(32)}`);
    const up = await sentCall(OLD);
    const report = await reconcile(
      clients,
      new Date(),
      receiptFor({ [`0x${'01'.repeat(32)}`]: new Error('bundler down'), [CALLS_ID]: { success: true, txHash: MINED } })
    );
    expect((await callOf(down)).state).toBe('sent');
    expect((await callOf(up)).state).toBe('landed');
    expect(report.ownerCalls).toEqual({ landed: 1, reverted: 0, open: 1 });
  });

  it('reads at most one batch of calls per run', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push(await sentCall(OLD));
    const receipt = receiptFor({ [CALLS_ID]: { success: true, txHash: MINED } });
    await reconcile(clients, new Date(), receipt);
    expect(receipt).toHaveBeenCalledTimes(50);
    const states = await Promise.all(ids.map(async (id) => (await callOf(id)).state));
    expect(states.filter((s) => s === 'landed')).toHaveLength(50);
    expect(states.filter((s) => s === 'sent')).toHaveLength(2);
  });

  it('leaves a call younger than the delay for the agent to ask about', async () => {
    const id = await sentCall(RECONCILE_AFTER_MS - 10_000);
    const receipt = receiptFor({ [CALLS_ID]: { success: true, txHash: MINED } });
    await reconcile(clients, new Date(), receipt);
    expect(receipt).not.toHaveBeenCalled();
    expect((await callOf(id)).state).toBe('sent');
  });

  it('touches no call that is not sent, including one that started sending and has no calls id', async () => {
    const declined = await openCall();
    await decline(t.connectionId, declined, 'owner_declined');
    const started = await openCall();
    await markSendStarted(t.connectionId, started);
    await Promise.all([declined, started].map((id) => ageCall(id, OLD)));
    const before = await Promise.all([declined, started].map(callOf));
    const receipt = receiptFor({ [CALLS_ID]: { success: true, txHash: MINED } });
    const report = await reconcile(clients, new Date(), receipt);
    expect(receipt).not.toHaveBeenCalled();
    expect(await Promise.all([declined, started].map(callOf))).toEqual(before);
    expect(before[1]).toMatchObject({ state: 'awaiting_owner', code: 'send_started', callsId: null });
    expect(report.ownerCalls).toEqual({ landed: 0, reverted: 0, open: 0 });
  });

  it('is answered by the status tool afterwards without asking the bundler', async () => {
    const id = await sentCall(OLD);
    await reconcile(clients, new Date(), receiptFor({ [CALLS_ID]: { success: false, txHash: MINED } }));
    const receipt = vi.fn<ReadReceipt>(async () => null);
    const result = await sendCallsStatus(t, { id }, { openWallet: noWallet, receipt, clients });
    expect(result.structuredContent).toMatchObject({ state: 'reverted', txHash: MINED, callsId: CALLS_ID });
    expect(receipt).not.toHaveBeenCalled();
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

  it('given a refusal kept pending for a retry, when metrics are read, then the gauge counts it failed', async () => {
    const gauge = async (state: string) => {
      const text = await (await call('metrics', 'cron-secret')).text();
      return Number(text.match(new RegExp(`^jaw_mcp_payments\\{state="${state}"\\} (\\d+)$`, 'm'))?.[1] ?? 0);
    };
    const before = [await gauge('pending'), await gauge('failed')];
    const id = `pay_${randomBytes(8).toString('hex')}`;
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
        state: 'pending',
        kind: 'refused',
        code: 'chain_unavailable',
        leaseUntil: minutesAgo(1),
      });

    expect([await gauge('pending'), await gauge('failed')]).toEqual([before[0], before[1] + 1]);
  });

  // Leaves each used refresh token holding its wrap a second past the retry window.
  const wrapsPastWindow = async (n: number) => {
    const issued = await Promise.all(Array.from({ length: n }, () => connect()));
    for (const c of issued) {
      await token({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: 'jaw-cli' });
    }
    const keys = issued.map((c) => createHash('sha256').update(`RefreshToken:${c.refresh_token}`).digest('hex'));
    await getDb()
      .update(oauthPayloads)
      .set({ consumedAt: sql`now() - interval '61 seconds'` })
      .where(inArray(oauthPayloads.key, keys));
  };
  const wrapsLeft = async () => {
    const [{ n }] = await getDb()
      .select({ n: count() })
      .from(oauthPayloads)
      .where(
        and(
          eq(oauthPayloads.model, 'RefreshToken'),
          isNotNull(oauthPayloads.consumedAt),
          isNotNull(oauthPayloads.keyWrap)
        )
      );
    return n;
  };

  it('given a wrap past the window, when the cron runs and the reconciler throws, then the wrap is gone', async () => {
    await wrapsPastWindow(1);
    expect(await wrapsLeft()).toBe(1);
    await getDb().execute(sql`alter table payments rename to payments_away`);
    try {
      expect((await call('cron', 'cron-secret')).status).toBe(500);
    } finally {
      await getDb().execute(sql`alter table payments_away rename to payments`);
    }
    expect(await wrapsLeft()).toBe(0);
  });

  it('given two wraps past the window, when metrics are read, then the gauge counts them until a sweep', async () => {
    await wrapsPastWindow(2);
    const gauge = async () =>
      (await (await call('metrics', 'cron-secret')).text()).match(/^jaw_mcp_wraps_past_window .*$/m)?.[0];
    expect(await gauge()).toBe('jaw_mcp_wraps_past_window 2');
    const res = await call('cron', 'cron-secret');
    expect(await res.json()).toHaveProperty('grantsRevoked');
    expect(await gauge()).toBe('jaw_mcp_wraps_past_window 0');
  });
});

describe('given an approval the owner never completed, past its expiry', () => {
  /** A pending connection whose owner signed in and, with `scope` that spends, holds a budget from connecting. */
  async function abandoned(scope = 'wallet:read x402:pay') {
    const signer = owner();
    setWallet({ openWallet: fakeWallet(walletAnswers(signer)) });
    const start = await startAuthorization(new Browser(), { scope });
    await walletsSettled();
    const [pending] = await getDb().select().from(connections).where(eq(connections.interactionUid, start.uid!));
    if (spends(pending.scopes)) await connectBudget(pending, signer);
    const [row] = await getDb()
      .update(connections)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(connections.interactionUid, start.uid!))
      .returning();
    return { row, owner: signer.address };
  }
  const rowAfter = async (id: string) => (await getDb().select().from(connections).where(eq(connections.id, id)))[0];
  const budgetOf = async (id: string) => (await getDb().select().from(grants).where(eq(grants.connectionId, id)))[0];
  const deps = (session: ReturnType<typeof sessionFakes>) => ({ readPermission: approvedOnChain, ...session.deps });

  it('when the purge runs, then the session revokes the budget, returns the prefund to the owner, and only then drops the key', async () => {
    const { row, owner: account } = await abandoned();
    const session = sessionFakes();

    await purge(deps(session));

    expect(session.sent).toHaveLength(1);
    const [revoke, sweep] = session.sent[0];
    expect(decodeFunctionData({ abi: PERMISSION_MANAGER_ABI, data: revoke.data }).functionName).toBe('revokeAsSpender');
    expect(decodeFunctionData({ abi: erc20Abi, data: sweep.data }).args).toEqual([account, 497_500n]);
    expect((await budgetOf(row.id)).revokedAt).not.toBeNull();
    expect((await rowAfter(row.id)).sealedKey).toBeNull();
  });

  it('when the batch does not land, then the key stays for the next run', async () => {
    const { row } = await abandoned();

    await purge(deps(sessionFakes({ status: 'reverted' })));
    expect((await rowAfter(row.id)).sealedKey).not.toBeNull();

    await purge(deps(sessionFakes()));
    expect((await rowAfter(row.id)).sealedKey).toBeNull();
  });

  it('when a float the key alone can move is stuck past a day, then the row and its key are kept', async () => {
    const { row } = await abandoned('wallet:read');
    await getDb()
      .update(connections)
      .set({ expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(connections.id, row.id));

    await purge(deps(sessionFakes({ status: 'reverted' })));

    expect((await rowAfter(row.id))?.sealedKey).toEqual(expect.any(String));
  });

  it('when nothing was granted and the payer is empty, then it drops the key without sending', async () => {
    const { row } = await abandoned('wallet:read');
    const session = sessionFakes(undefined, 0n);

    await purge(deps(session));

    expect(session.sent).toEqual([]);
    expect((await rowAfter(row.id)).sealedKey).toBeNull();
  });
});

/** A budget granted while connecting, which connections made before connect stopped asking for one still hold. */
async function connectBudget(row: typeof connections.$inferSelect, signer: ReturnType<typeof owner>) {
  const grant = budgetGrant({
    chainId: row.chainId,
    spender: row.sessionAddress as Address,
    token: usdcForNetwork(`eip155:${row.chainId}`)!.address,
    allowance: 1_000_000n,
    expiry: Math.floor(row.expiresAt.getTime() / 1000),
  });
  const answer = await walletAnswers(signer)('wallet_grantPermissions', [grant]);
  const checked = await checkGranted(row.chainId, grant, 'x402-budget', answer, approvedOnChain);
  if (typeof checked === 'string') throw new Error(checked);
  await getDb().transaction((tx) => recordGrant(tx, row.id, checked));
}

describe('given an activated connection whose code was never exchanged, past the exchange window', () => {
  /** An active connection the owner completed but whose authorization code was never exchanged. */
  async function activeNeverExchanged(scope = 'wallet:read x402:pay') {
    const signer = owner();
    const browser = new Browser();
    browser.wallet = {
      openWallet: fakeWallet(walletAnswers(signer)),
      verify: verifyLocally,
    };
    const start = await startAuthorization(browser, { scope });
    if (!start.uid || !start.ticket) throw new Error('did not reach the wallet');
    await walletsSettled();
    await follow(browser, `${ISSUER}/interaction/${start.uid}/complete?ticket=${start.ticket}`);
    const [connected] = await getDb().select().from(connections).where(eq(connections.interactionUid, start.uid!));
    if (spends(connected.scopes)) await connectBudget(connected, signer);
    // 181 seconds: past the 180 s exchange window (60 s AuthorizationCode TTL + 120 s margin).
    const [row] = await getDb()
      .update(connections)
      .set({ activatedAt: sql`now() - interval '181 seconds'` })
      .where(eq(connections.interactionUid, start.uid!))
      .returning();
    return { row, owner: signer.address };
  }

  const rowAfter = async (id: string) => (await getDb().select().from(connections).where(eq(connections.id, id)))[0];
  const budgetOf = async (id: string) => (await getDb().select().from(grants).where(eq(grants.connectionId, id)))[0];
  const deps = (session: ReturnType<typeof sessionFakes>) => ({ readPermission: approvedOnChain, ...session.deps });

  it('retires the connection and clears its sealed key', async () => {
    const { row } = await activeNeverExchanged();
    expect(row.sealedKey).not.toBeNull();
    const session = sessionFakes();

    await purge(deps(session));

    expect(await rowAfter(row.id)).toMatchObject({ sealedKey: null, status: 'revoked' });
    expect((await budgetOf(row.id)).revokedAt).not.toBeNull();
  });

  it('does not touch a row exchanged in time', async () => {
    const c = await connect();
    const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const before = await rowAfter(tenant.connectionId);
    expect(before.sealedKey).toBeNull();

    await purge(deps(sessionFakes()));

    const after = await rowAfter(tenant.connectionId);
    expect(after.status).toBe('active');
    expect(after.sealedKey).toBeNull();
  });

  it('does not touch a row still within the exchange window', async () => {
    const signer = owner();
    const browser = new Browser();
    browser.wallet = {
      openWallet: fakeWallet(walletAnswers(signer)),
      verify: verifyLocally,
    };
    const start = await startAuthorization(browser, {});
    if (!start.uid || !start.ticket) throw new Error('did not reach the wallet');
    await walletsSettled();
    await follow(browser, `${ISSUER}/interaction/${start.uid}/complete?ticket=${start.ticket}`);
    const [row] = await getDb().select().from(connections).where(eq(connections.interactionUid, start.uid!));

    await purge(deps(sessionFakes()));

    expect((await rowAfter(row.id)).sealedKey).not.toBeNull();
  });

  it('the exchange vs retire race has exactly one winner', async () => {
    const { row } = await activeNeverExchanged();
    expect(row.sealedKey).not.toBeNull();

    await purge(deps(sessionFakes()));

    const taken = await takeSealedKey(row.id);
    expect(taken).toBeUndefined();
    expect((await rowAfter(row.id)).sealedKey).toBeNull();
  });

  it('clears the sealed key on a hand_back_failed row', async () => {
    const signer = owner();
    const browser = new Browser();
    browser.wallet = {
      openWallet: fakeWallet(walletAnswers(signer)),
      verify: verifyLocally,
    };
    const start = await startAuthorization(browser, { scope: 'wallet:read x402:pay' });
    if (!start.uid || !start.ticket) throw new Error('did not reach the wallet');
    await walletsSettled();
    await follow(browser, `${ISSUER}/interaction/${start.uid}/complete?ticket=${start.ticket}`);
    // Simulate hand_back_failed: activated then revoked, key never cleared.
    await getDb()
      .update(connections)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        activatedAt: sql`now() - interval '181 seconds'`,
      })
      .where(eq(connections.interactionUid, start.uid!));
    const [row] = await getDb().select().from(connections).where(eq(connections.interactionUid, start.uid!));

    await purge(deps(sessionFakes()));

    expect((await rowAfter(row.id)).sealedKey).toBeNull();
  });

  it('keeps the key and logs at error when the retire fails', async () => {
    const { row } = await activeNeverExchanged();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await purge(deps(sessionFakes({ status: 'reverted' })));

      expect((await rowAfter(row.id)).sealedKey).not.toBeNull();
      const errors = logged.mock.calls.filter(
        ([line]) => typeof line === 'string' && line.includes(row.id) && line.includes('"level":"error"')
      );
      expect(errors.length).toBeGreaterThanOrEqual(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('sent owner calls the bundler no longer answers for', () => {
  const QUIET = 30 * 60_000;
  const event = (over: Partial<FakeEvent> = {}): FakeEvent => ({
    userOpHash: CALLS_ID as Hex,
    block: 9_500n,
    txHash: MINED as Hex,
    success: true,
    ...over,
  });
  const stale = async (callsId = CALLS_ID) => {
    const id = await sentCall(0, callsId);
    await getDb().update(ownerCalls).set({ sentBlock: 9_000n }).where(eq(ownerCalls.id, id));
    await ageCall(id, QUIET);
    return id;
  };
  const sweep = (chain: ReturnType<typeof fakeChain>) => reconcile(chain.clients, new Date(), receiptFor({}));

  beforeEach(() => withoutOwnerCallsGuard(() => getDb().delete(ownerCalls)));

  it('concludes a call as landed from the event on chain', async () => {
    const id = await stale();
    const report = await sweep(fakeChain({ head: 10_000n, events: [event()] }));

    expect(report.ownerCalls).toEqual({ landed: 1, reverted: 0, open: 0 });
    expect(await callOf(id)).toMatchObject({ state: 'landed', txHash: MINED });
  });

  it('concludes a call as reverted when the event says the operation failed', async () => {
    const id = await stale();
    const report = await sweep(fakeChain({ head: 10_000n, events: [event({ success: false })] }));

    expect(report.ownerCalls).toEqual({ landed: 0, reverted: 1, open: 0 });
    expect((await callOf(id)).state).toBe('reverted');
  });

  it('keeps a call sent when no event is found', async () => {
    const id = await stale();
    const report = await sweep(fakeChain({ head: 10_000n }));

    expect(report.ownerCalls).toEqual({ landed: 0, reverted: 0, open: 1 });
    expect((await callOf(id)).state).toBe('sent');
  });

  it('searches the chain for at most five calls per run and asks the bundler about all of them', async () => {
    const hashes = Array.from({ length: 7 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as Hex);
    const ids: string[] = [];
    for (const h of hashes) ids.push(await stale(h));
    const chain = fakeChain({ head: 10_000n, events: hashes.map((h) => event({ userOpHash: h })) });
    const bundler = receiptFor({});

    const report = await reconcile(chain.clients, new Date(), bundler);

    expect(bundler).toHaveBeenCalledTimes(7);
    expect(report.ownerCalls).toEqual({ landed: 5, reverted: 0, open: 2 });
    expect((await Promise.all(ids.map(callOf))).filter((c) => c.state === 'sent')).toHaveLength(2);
  });

  it('does not read logs for a call whose searched span is already behind the head', async () => {
    const id = await stale();
    const chain = fakeChain({ head: 100_000n, events: [event()] });

    const report = await sweep(chain);

    expect(chain.ranges).toEqual([]);
    expect(report.ownerCalls.open).toBe(1);
    expect((await callOf(id)).state).toBe('sent');
  });

  it('does not read the chain for a call sent minutes ago', async () => {
    const id = await sentCall(OLD);
    const chain = fakeChain({ head: 10_000n, events: [event()] });
    const report = await sweep(chain);

    expect(chain.ranges).toEqual([]);
    expect(report.ownerCalls.open).toBe(1);
    expect((await callOf(id)).state).toBe('sent');
  });

  it('logs and skips a call whose chain cannot be read', async () => {
    const id = await stale();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = await sweep(fakeChain({ head: 10_000n, down: true }));

      expect(report.ownerCalls).toEqual({ landed: 0, reverted: 0, open: 1 });
      expect((await callOf(id)).state).toBe('sent');
      expect(logged.mock.calls.some(([line]) => String(line).includes(`owner call ${id} not settled`))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('given grants the owner may have revoked in the wallet', () => {
  async function grantRows(over: { expiresAt?: Date; revokedAt?: Date }[]) {
    const c = await connect();
    const { connectionId, account } = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
    const ids = over.map(() => hex32());
    await getDb()
      .insert(grants)
      .values(
        over.map((o, i) => ({
          permissionId: ids[i],
          connectionId,
          chainId: 84532,
          account,
          spender: payer,
          kind: 'custom' as const,
          permission: { id: ids[i] },
          expiresAt: o.expiresAt ?? new Date(Date.now() + 86_400_000),
          revokedAt: o.revokedAt,
        }))
      );
    return ids;
  }
  const revokedAtOf = async (id: string) =>
    (await getDb().select().from(grants).where(eq(grants.permissionId, id)))[0].revokedAt;

  it('when the sweep runs, then only the one revoked on chain is marked, and expired or already revoked ones are not read', async () => {
    const earlier = new Date(Date.now() - 3_600_000);
    const [revoked, unapproved, mismatched, live, expired, marked] = await grantRows([
      {},
      {},
      {},
      {},
      { expiresAt: new Date(Date.now() - 60_000) },
      { revokedAt: earlier },
    ]);
    const answers: Record<string, PermissionState> = {
      [revoked]: { status: 'ok', approved: true, revoked: true },
      [unapproved]: { status: 'ok', approved: false, revoked: false },
      [mismatched]: { status: 'mismatch' },
    };
    const read: string[] = [];
    const count = await sweepRevokedGrants(async ({ permissionId }) => {
      read.push(permissionId);
      return answers[permissionId] ?? { status: 'ok', approved: true, revoked: false };
    }, 10_000);

    expect(count).toBe(1);
    expect(await revokedAtOf(revoked)).toBeInstanceOf(Date);
    for (const id of [unapproved, mismatched, live, expired]) expect(await revokedAtOf(id)).toBeNull();
    expect(await revokedAtOf(marked)).toEqual(earlier);
    expect(read).toEqual(expect.arrayContaining([revoked, unapproved, mismatched, live]));
    expect(read).not.toContain(expired);
    expect(read).not.toContain(marked);
  });

  it('when the chain cannot be read, then the sweep stops after three reads in a row, records nothing and reports it failed', async () => {
    const [revoked] = await grantRows([{}, {}, {}, {}]);
    let reads = 0;
    const count = await sweepRevokedGrants(async () => {
      reads++;
      throw new Error('node down');
    }, 10_000);
    expect(count).toBeNull();
    expect(reads).toBe(3);
    expect(await revokedAtOf(revoked)).toBeNull();
  });

  it('when one grant cannot be read, then the sweep reads past it and records the revoked ones', async () => {
    const [unreadable, revoked] = await grantRows([{}, {}]);
    const count = await sweepRevokedGrants(async ({ permissionId }) => {
      if (permissionId === unreadable) throw new Error('no client for this chain');
      return { status: 'ok', approved: true, revoked: permissionId === revoked };
    }, 10_000);
    expect(count).toBe(1);
    expect(await revokedAtOf(revoked)).toBeInstanceOf(Date);
  });

  it('when another caller recorded the revoke first, then the sweep does not count it again', async () => {
    const [revoked] = await grantRows([{}]);
    const read = async ({ permissionId }: { permissionId: string }): Promise<PermissionState> => {
      if (permissionId !== revoked) return { status: 'ok', approved: true, revoked: false };
      await recordRevoked([revoked]);
      return { status: 'ok', approved: true, revoked: true };
    };
    expect(await sweepRevokedGrants(read, 10_000)).toBe(0);
  });

  it('when the sample is smaller than the live grants, then it reads no more than the limit', async () => {
    await grantRows([{}, {}, {}]);
    const read: string[] = [];
    await sweepRevokedGrants(async ({ permissionId }) => {
      read.push(permissionId);
      return { status: 'ok', approved: true, revoked: false };
    }, 2);
    expect(read).toHaveLength(2);
  });

  it('when a grant already recorded revoked is recorded again, then it keeps the first time', async () => {
    const earlier = new Date(Date.now() - 3_600_000);
    const [marked] = await grantRows([{ revokedAt: earlier }]);
    await recordRevoked([marked]);
    expect(await revokedAtOf(marked)).toEqual(earlier);
  });

  it('when the store cannot be read, then the sweep reports it failed and does not throw', async () => {
    const spy = vi.spyOn(getDb(), 'select').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(sweepRevokedGrants(async () => ({ status: 'unavailable' }))).resolves.toBeNull();
    spy.mockRestore();
  });
});
