import { randomBytes } from 'node:crypto';
import type { GrantedPermission } from '@jaw.id/agent';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Hex } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { replayingPage, stallsAfter, startRelay } from '@/connections/fake-relay';
import { ownerRelay, type Ask } from '@/connections/relay';
import { sealResume } from '@/connections/seal';
import {
  approvedOnChain,
  connect,
  grantBudget,
  offlineSession,
  owner,
  setTestEnv,
  walletAnswers,
  walletsSettled,
} from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, grants, permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { grantPermissions } from '@/tools/grant-permissions';
import { revokePermission, type RevokeDeps } from '@/tools/revoke-permission';
import { sign } from '@/tools/sign';
import { grantWork, signWork } from './resume';
import { checkGranted, recordGrant, type GrantRequest, type ReadPermission } from './permission';
import { closeLapsedLinks, resumeOpen } from './requests';
import { LIVE_GRANTS_PER_CONNECTION } from './store';

const relay = await startRelay();
setTestEnv();
process.env.JAW_RELAY_URL = relay.url;
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterAll(() => relay.close());
afterEach(() => vi.useRealTimers());

async function connected() {
  const signer = owner();
  const c = await connect(signer);
  await walletsSettled();
  return { signer, t: (await verifyBearer(c.access_token))?.extra?.tenant as Tenant };
}

function deciding(answer: Ask) {
  let decide!: () => void;
  const decided = new Promise<void>((r) => (decide = r));
  const asked = async (method: string, params: unknown) => {
    if (method !== 'eth_requestAccounts') await decided;
    return answer(method, params as unknown[]);
  };
  return { answer: asked, decide };
}

const rowOf = async (id: string) =>
  (await getDb().select().from(permissionRequests).where(eq(permissionRequests.id, id)))[0];
const rowsOf = (t: Tenant) =>
  getDb().select().from(permissionRequests).where(eq(permissionRequests.connectionId, t.connectionId));
const lapse = (id: string) =>
  getDb().update(permissionRequests).set({ sessionUntil: null }).where(eq(permissionRequests.id, id));
const settled = (id: string) =>
  vi.waitFor(
    async () => {
      const row = await rowOf(id);
      expect(row.state).not.toBe('awaiting_owner');
      return row;
    },
    { timeout: 10_000 }
  );
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const resumeSigns = async () => Promise.all(await resumeOpen({ sign: signWork }));

async function askedThenRestarted(message = 'sign in', opts: { replays?: boolean; stallAt?: number } = {}) {
  const { signer, t } = await connected();
  const key = `k_${randomBytes(4).toString('hex')}`;
  const owned = deciding(async (method) =>
    method === 'eth_requestAccounts' ? [signer.address] : signer.signMessage({ message })
  );
  const stallAt = opts.stallAt ?? 2;
  const server = stallsAfter(stallAt);
  const first = await sign(t, { message, idempotencyKey: key }, { openWallet: server.openWallet });
  const page = await replayingPage(first.structuredContent!.url!, owned.answer, opts);
  await vi.waitFor(() => expect(page.ids).toHaveLength(stallAt));
  const [row] = await rowsOf(t);
  await lapse(row.id);
  return { signer, t, key, message, row, page, server, decide: owned.decide };
}

describe('a sign request whose server restarted', () => {
  it.each(['while the server was down', 'after the server rejoined'])(
    'given the page is still open, when the owner approves %s, then a status read resumes it and the row ends approved with the signature',
    async (when) => {
      const { signer, t, key, message, row, page, decide } = await askedThenRestarted();
      if (when === 'while the server was down') decide();

      const read = await sign(t, { message, idempotencyKey: key }, { openWallet: stallsAfter(9).openWallet });
      expect(read.structuredContent?.state).toBe('awaiting_owner');
      await vi.waitFor(() => expect(page.ids).toHaveLength(4));
      decide();

      const done = await settled(row.id);
      expect(done).toMatchObject({ state: 'approved', relay: null });
      expect(done.signature).toBe(await signer.signMessage({ message }));
      expect(page.ids).toEqual([...page.ids.slice(0, 2), ...page.ids.slice(0, 2)]);
      expect(page.asked()).toBe(2);
    }
  );

  it('given the relay drops this server while the owner decides, then the request keeps its relay session and the next tick resumes it to approved', async () => {
    const { signer, t } = await connected();
    const message = 'sign in';
    const owned = deciding(async (method) =>
      method === 'eth_requestAccounts' ? [signer.address] : signer.signMessage({ message })
    );
    const first = await sign(t, { message }, { openWallet: stallsAfter(9).openWallet });
    const page = await replayingPage(first.structuredContent!.url!, owned.answer);
    await vi.waitFor(() => expect(page.ids).toHaveLength(2));
    const [row] = await rowsOf(t);

    relay.sessions.get(new URL(first.structuredContent!.url!).searchParams.get('session')!)!.cli!.close();
    await vi.waitFor(async () => expect((await rowOf(row.id)).sessionUntil).toBeNull());
    expect(await rowOf(row.id)).toMatchObject({ state: 'awaiting_owner', relay: expect.any(String) });
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: sql`statement_timestamp() - interval '2 minutes'` })
      .where(eq(permissionRequests.id, row.id));

    await resumeSigns();
    owned.decide();

    expect(await settled(row.id)).toMatchObject({ state: 'approved' });
  });

  it('given the relay drops every resumed run after it rejoins, then each drop counts a failed rejoin and the fifth ends the wait for a resume', async () => {
    const { signer, t } = await connected();
    const never = new Promise<never>(() => {});
    const first = await sign(t, { message: 'sign in' }, { openWallet: stallsAfter(9).openWallet });
    const url = first.structuredContent!.url!;
    const session = new URL(url).searchParams.get('session')!;
    const page = await replayingPage(url, async (method) =>
      method === 'eth_requestAccounts' ? [signer.address] : never
    );
    await vi.waitFor(() => expect(page.ids).toHaveLength(2));
    const [row] = await rowsOf(t);
    relay.sessions.get(session)!.cli!.close();
    await vi.waitFor(async () => expect((await rowOf(row.id)).sessionUntil).toBeNull());

    const failures: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const inits = page.inits();
      await resumeSigns();
      await vi.waitFor(() => expect(page.inits()).toBeGreaterThan(inits));
      await vi.waitFor(() => expect(relay.sessions.get(session)?.cli).toBeDefined());
      relay.sessions.get(session)!.cli!.close();
      await vi.waitFor(async () => expect((await rowOf(row.id)).resumeFailures).toBe(i));
      failures.push((await rowOf(row.id)).resumeFailures);
      await lapse(row.id);
    }

    expect(failures).toEqual([1, 2, 3, 4, 5]);
    expect(await rowOf(row.id)).toMatchObject({ state: 'awaiting_owner', relay: null });
    expect(await resumeSigns()).toEqual([]);
  });

  it('given the page was closed, when the server rejoins, then the row ends link_lost and nothing is stored to resume', async () => {
    const { row, page } = await askedThenRestarted();
    page.close();
    await vi.waitFor(() =>
      expect(relay.sessions.get(row.walletUrl.match(/session=([^&]+)/)![1])?.browser).toBeUndefined()
    );

    await resumeSigns();

    expect(await settled(row.id)).toMatchObject({ state: 'expired', code: 'link_lost', relay: null });
  });

  it('given a page that does not say it replays, then no relay session is stored and nothing is asked again', async () => {
    const { row, page } = await askedThenRestarted('sign in', { replays: false });
    expect((await rowOf(row.id)).relay).toBeNull();

    await resumeSigns();
    await pause();

    expect(page.ids).toHaveLength(2);
  });

  it('given two processes resume at once, then only one asks the page again', async () => {
    const { row, page, decide } = await askedThenRestarted();

    await Promise.all([resumeSigns(), resumeSigns()]);
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));
    await pause(500);

    expect(page.ids).toHaveLength(4);
    expect(page.inits()).toBe(2);
    decide();
    expect(await settled(row.id)).toMatchObject({ state: 'approved' });
  });

  it('given a resumer took the lease, when the old process hears the signature first, then that answer is recorded', async () => {
    const { signer, message, row, page, server } = await askedThenRestarted();
    await resumeSigns();
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));

    server.wake(undefined, await signer.signMessage({ message }));

    expect(await settled(row.id)).toMatchObject({
      state: 'approved',
      signature: await signer.signMessage({ message }),
    });
  });

  it('given a resumer took the lease, when the old process hears a wallet error, then it writes nothing and the resumed answer stands', async () => {
    const { row, page, server, decide } = await askedThenRestarted();
    await resumeSigns();
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));

    server.wake(Object.assign(new Error('wallet failed'), { code: -32603 }));
    await pause();
    expect((await rowOf(row.id)).state).toBe('awaiting_owner');
    decide();

    expect(await settled(row.id)).toMatchObject({ state: 'approved' });
  });

  it('given a resumer took the lease before the old process claimed the row, when the old process wakes up, then its claim fails and it asks nothing more', async () => {
    const { row, page, server, decide } = await askedThenRestarted('sign in', { stallAt: 1 });
    await resumeSigns();
    await vi.waitFor(() => expect(page.ids).toHaveLength(3));

    server.wake();
    await pause();

    expect(page.ids).toHaveLength(3);
    decide();
    expect(await settled(row.id)).toMatchObject({ state: 'approved' });
  });

  it('given a resumer took the lease, when the old process renews, then it loses the link and closes its session', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { page, server } = await askedThenRestarted();
    await resumeSigns();
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));

    await vi.advanceTimersByTimeAsync(10_000);

    await vi.waitFor(() => expect(server.closed()).toBe(true));
  });

  it('given another process holds the row when the page becomes ready, then this process stores no relay session', async () => {
    const { signer, t } = await connected();
    const first = await sign(t, { message: 'hi', idempotencyKey: 'late' }, { openWallet: ownerRelay });
    const [row] = await rowsOf(t);
    await getDb().update(permissionRequests).set({ leaseHolder: 'another' }).where(eq(permissionRequests.id, row.id));

    const page = await replayingPage(first.structuredContent!.url!, async () => [signer.address]);
    await vi.waitFor(() => expect(page.ids).toHaveLength(1));
    await pause();

    expect((await rowOf(row.id)).relay).toBeNull();
  });

  it('given the reconciler sweeps lapsed links, then a row waiting for its resume is left open', async () => {
    const { row } = await askedThenRestarted();

    await closeLapsedLinks();

    expect(await rowOf(row.id)).toMatchObject({ state: 'awaiting_owner', relay: expect.any(String) });
  });

  it('given the connection ended meanwhile, when the server rejoins, then the row ends connection_ended and the page is not asked again', async () => {
    const { t, row, page } = await askedThenRestarted();
    await getDb()
      .update(connections)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(connections.id, t.connectionId));

    await resumeSigns();

    expect(await settled(row.id)).toMatchObject({ state: 'failed', code: 'connection_ended', relay: null });
    expect(page.ids).toHaveLength(2);
  });

  it('given a relay session the key ring cannot open, then the row ends link_lost instead of failing every tick', async () => {
    const { row, page } = await askedThenRestarted();
    await getDb()
      .update(permissionRequests)
      .set({ relay: `r1.retired.${randomBytes(12).toString('base64url')}.${randomBytes(40).toString('base64url')}` })
      .where(eq(permissionRequests.id, row.id));

    await resumeSigns();

    expect(await settled(row.id)).toMatchObject({ state: 'expired', code: 'link_lost', relay: null });
    expect(page.ids).toHaveLength(2);
  });

  it('given a stored payload that does not parse, then the row ends link_lost and no session is opened on the relay', async () => {
    const { row, page } = await askedThenRestarted();
    await getDb().update(permissionRequests).set({ payload: '{' }).where(eq(permissionRequests.id, row.id));

    await resumeSigns();

    expect(await settled(row.id)).toMatchObject({ state: 'expired', code: 'link_lost', relay: null });
    expect(page.inits()).toBe(1);
  });

  it.each(['{}', '{"chainId":84532,"request":{"type":"0x45"}}'])(
    'given a stored payload %s that is not a sign request, then the row ends and no session is opened on the relay',
    async (payload) => {
      const { row, page } = await askedThenRestarted();
      await getDb().update(permissionRequests).set({ payload }).where(eq(permissionRequests.id, row.id));

      await resumeSigns();

      expect(await settled(row.id)).toMatchObject({ state: 'expired', relay: null });
      expect(page.inits()).toBe(1);
    }
  );

  it.each([
    ['a relay session the key ring cannot open', { relay: 'r1.retired.x.y' }],
    ['a payload that is not a sign request', { payload: '{}' }],
  ])(
    'given a request the owner was never asked to sign, when %s is found, then it ends session_lost, not link_lost',
    async (_, set) => {
      const { row } = await askedThenRestarted('sign in', { stallAt: 1 });
      expect(row.code).toBeNull();
      await getDb().update(permissionRequests).set(set).where(eq(permissionRequests.id, row.id));

      await resumeSigns();

      expect(await settled(row.id)).toMatchObject({ state: 'expired', code: 'session_lost' });
    }
  );

  it('given the page refuses a resumed ask as another request under its id, then the row ends link_lost, not as a wallet error', async () => {
    const { row } = await askedThenRestarted();
    const payload = JSON.parse(row.payload!) as { request: { data: { message: string } } };
    payload.request.data.message = 'something else';
    await getDb()
      .update(permissionRequests)
      .set({ payload: JSON.stringify(payload) })
      .where(eq(permissionRequests.id, row.id));

    await resumeSigns();

    expect(await settled(row.id)).toMatchObject({ state: 'expired', code: 'link_lost' });
  });
});

const CUSTOM = { calls: [{ target: `0x${'12'.repeat(20)}`, functionSignature: 'transfer(address,uint256)' }] };

describe('a grant request whose server restarted', () => {
  it('given the page is still open, when the agent asks again, then it waits on the same link, resumes it, and the grant the owner approves is recorded', async () => {
    const { signer, t } = await connected();
    const owned = deciding(walletAnswers(signer));
    const deps = { openWallet: stallsAfter(1).openWallet, readPermission: approvedOnChain, session: offlineSession };
    await grantPermissions(t, CUSTOM, deps);
    const [row] = await rowsOf(t);
    const page = await replayingPage(row.walletUrl, owned.answer);
    await vi.waitFor(() => expect(page.ids).toHaveLength(1));
    await lapse(row.id);

    const again = await grantPermissions(t, CUSTOM, deps);
    expect(again.content[0].text).toContain(`open at ${row.walletUrl}`);
    expect(again.content[0].text).toContain("reconnecting to the owner's open link");
    await vi.waitFor(() => expect(page.ids).toHaveLength(2));
    owned.decide();

    const done = await settled(row.id);
    expect(done).toMatchObject({ state: 'approved', permissionId: expect.stringMatching(/^0x/) });
    expect(await getDb().select().from(grants).where(eq(grants.permissionId, done.permissionId!))).toHaveLength(1);
    expect(page.asked()).toBe(1);
  });

  it('given the grant the owner approved is already recorded and fills the connection, when the server rejoins, then the row ends approved', async () => {
    const { signer, t } = await connected();
    let answered: Record<string, unknown> | undefined;
    const honest = walletAnswers(signer);
    await grantPermissions(t, CUSTOM, {
      openWallet: stallsAfter(1).openWallet,
      readPermission: approvedOnChain,
      session: offlineSession,
    });
    const [row] = await rowsOf(t);
    const page = await replayingPage(row.walletUrl, async (method, params) => {
      answered = (await honest(method, params as unknown[])) as Record<string, unknown>;
      return answered;
    });
    await vi.waitFor(() => expect(answered).toBeDefined());
    const { grant, kind } = JSON.parse(row.payload!) as { grant: GrantRequest; kind: 'custom' };
    const checked = await checkGranted(t.chainId, grant, kind, answered, approvedOnChain);
    if (typeof checked === 'string') throw new Error(checked);
    await getDb().transaction(async (tx) => {
      await recordGrant(tx, t.connectionId, checked);
      for (let n = 2; n < LIVE_GRANTS_PER_CONNECTION; n++) {
        await recordGrant(tx, t.connectionId, { ...checked, permissionId: `0x${randomBytes(32).toString('hex')}` });
      }
    });
    await lapse(row.id);

    await Promise.all(await resumeOpen({ grant: grantWork(approvedOnChain) }));

    expect(await settled(row.id)).toMatchObject({ state: 'approved', permissionId: answered!.permissionId });
    expect(page.asked()).toBe(1);
    const [{ n }] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(grants)
      .where(eq(grants.permissionId, answered!.permissionId as Hex));
    expect(n).toBe(1);
  });
});

describe('a revoke request whose server restarted', () => {
  it('given the page is still open, when the agent asks again, then it waits on the same link, resumes it, and the revoke the owner approves is recorded', async () => {
    const { signer, t } = await connected();
    const permissionId = (await grantBudget(t, signer))!.permissionId as Hex;
    const revoked = new Set<string>();
    const readPermission: ReadPermission = async ({ permissionId: id }) => ({
      status: 'ok',
      approved: true,
      revoked: revoked.has(id.toLowerCase()),
    });
    const honest = walletAnswers(signer);
    const owned = deciding(async (method, params) => {
      if (method !== 'wallet_revokePermissions') return honest(method, params);
      revoked.add((params[0] as { id: string }).id.toLowerCase());
      return { success: true };
    });
    const deps: RevokeDeps = {
      openWallet: stallsAfter(2).openWallet,
      readPermission,
      rereadMs: 1,
      lookUp: async (id) => {
        const [g] = await getDb().select().from(grants).where(eq(grants.permissionId, id));
        return { permission: g.permission as GrantedPermission, chainId: g.chainId };
      },
    };
    await revokePermission(t, { permissionId }, deps);
    const row = (await rowsOf(t)).find((r) => r.method === 'revoke')!;
    const page = await replayingPage(row.walletUrl, owned.answer);
    await vi.waitFor(() => expect(page.ids).toHaveLength(2));
    await lapse(row.id);

    const again = await revokePermission(t, { permissionId }, deps);
    expect('structuredContent' in again && again.structuredContent?.url).toBe(row.walletUrl);
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));
    owned.decide();

    expect(await settled(row.id)).toMatchObject({ state: 'approved', code: null });
    expect(
      (await getDb().select().from(grants).where(eq(grants.permissionId, permissionId)))[0].revokedAt
    ).not.toBeNull();
    expect(page.asked()).toBe(2);
  });
});

describe('the resumes one tick starts', () => {
  it('given six requests that keep failing to resume, then a tick starts the five tried longest ago and the next starts the last', async () => {
    const newest = await failingRow(1);
    const older: string[] = [];
    for (let i = 0; i < 5; i++) older.push(await failingRow(10));
    const all = [newest, ...older];
    const before = new Map((await rowsById(all)).map((r) => [r.id, r.updatedAt.getTime()]));
    const tried = async () => (await rowsById(all)).filter((r) => r.updatedAt.getTime() > before.get(r.id)!);

    await resumeSigns();
    expect((await tried()).map((r) => r.id).sort()).toEqual([...older].sort());

    await resumeSigns();
    expect((await tried()).map((r) => r.id)).toContain(newest);
    await getDb().delete(permissionRequests).where(inArray(permissionRequests.id, all));
  });
});

const rowsById = (ids: string[]) =>
  getDb().select().from(permissionRequests).where(inArray(permissionRequests.id, ids));

async function failingRow(minutesAgo: number): Promise<string> {
  const id = randomBytes(8).toString('hex');
  await getDb()
    .insert(connections)
    .values({
      id: `c_${id}`,
      status: 'active',
      account: `0x${'ab'.repeat(20)}`,
      chainId: 84532,
      clientId: 'jaw-cli',
      clientName: 'JAW CLI',
      scopes: ['wallet:read'],
      sessionAddress: `0x${'cd'.repeat(20)}`,
      interactionUid: `i_${id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      grantId: `g_${id}`,
      activatedAt: new Date(),
    });
  const rowId = `pr_${id}`;
  const resume = { session: id, key: 'zz', peer: '00', chainId: 84532, appName: 'JAW CLI' };
  await getDb()
    .insert(permissionRequests)
    .values({
      id: rowId,
      connectionId: `c_${id}`,
      method: 'sign',
      chainId: 84532,
      account: `0x${'ab'.repeat(20)}`,
      idempotencyKey: id,
      requestHash: id,
      signKind: 'message',
      walletUrl: 'http://keys.test/cli-bridge',
      approveBy: new Date(Date.now() + 60_000),
      code: 'asked',
      payload: '{}',
      relay: sealResume(config().ring, resume, rowId),
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
  return rowId;
}
