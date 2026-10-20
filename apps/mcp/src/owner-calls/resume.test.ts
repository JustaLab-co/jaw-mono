import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { replayingPage, stallsAfter, startRelay } from '@/connections/fake-relay';
import { ownerRelay, WalletBusy, type Wallet } from '@/connections/relay';
import { sealResume, type RelayResume } from '@/connections/seal';
import { connect, owner, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, ownerCalls, permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres, withoutOwnerCallsGuard } from '@/db/test-db';
import { sendCalls, sendCallsStatus, type OwnerCallDeps } from '@/tools/owner-calls';
import { resumeTick } from '@/connections/resume';
import { requestsWaiting } from '@/grants/resume';
import { callsWaiting, resumeOwnerCalls } from './resume';
import { fakeChain } from './chain-testkit';
import { SEND_STARTED } from './store';

const relay = await startRelay();
setTestEnv();
process.env.JAW_RELAY_URL = relay.url;
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterAll(() => relay.close());

const CALLS_ID = `0x${'cd'.repeat(32)}`;
const CALL = { to: '0x2222222222222222222222222222222222222222', data: '0xa9059cbb', value: '5' };
const clients = fakeChain({ head: 1_000_000n }).clients;

async function connected() {
  const signer = owner();
  const c = await connect(signer);
  await walletsSettled();
  return (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
}

const depsOf = (openWallet: OwnerCallDeps['openWallet']): OwnerCallDeps => ({
  openWallet,
  receipt: async () => null,
  clients,
});

const rowOf = async (id: string) => (await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, id)))[0];
const lapse = (id: string) => getDb().update(ownerCalls).set({ sessionUntil: null }).where(eq(ownerCalls.id, id));
const sent = (id: string) =>
  vi.waitFor(
    async () => {
      const row = await rowOf(id);
      expect(row.state).toBe('sent');
      return row;
    },
    { timeout: 10_000 }
  );
const quiet = () => new Promise((r) => setTimeout(r, 300));

function deciding(t: Tenant, refuseAccounts?: number, holdAccounts = false) {
  let decide!: () => void;
  const decided = new Promise<void>((r) => (decide = r));
  let signIn!: () => void;
  const signedIn = new Promise<void>((r) => (signIn = r));
  if (!holdAccounts) signIn();
  const answer = async (method: string) => {
    if (method === 'eth_requestAccounts') {
      await signedIn;
      if (refuseAccounts) throw Object.assign(new Error('refused'), { code: refuseAccounts });
      return [t.account];
    }
    await decided;
    return { id: CALLS_ID };
  };
  return { answer, decide, signIn };
}

async function sendStartedThenRestarted(opts: { replays?: boolean; stallAt?: number; holdAccounts?: boolean } = {}) {
  const t = await connected();
  const key = `k_${randomBytes(4).toString('hex')}`;
  const owned = deciding(t, undefined, opts.holdAccounts);
  const server = stallsAfter(opts.stallAt ?? 2);
  const first = await sendCalls(t, { calls: [CALL], idempotencyKey: key }, depsOf(server.openWallet));
  const id = first.structuredContent!.id;
  const page = await replayingPage(first.structuredContent!.url!, owned.answer, opts);
  await vi.waitFor(() => expect(page.ids).toHaveLength(opts.stallAt ?? 2));
  await lapse(id);
  return { t, key, id, url: first.structuredContent!.url!, page, server, decide: owned.decide, signIn: owned.signIn };
}

describe('owner calls whose server restarted after the send started', () => {
  it.each(['while the server was down', 'after the server rejoined'])(
    'given the page is still open, when the owner approves %s, then a status read resumes it and the row ends sent with the calls id',
    async (when) => {
      const { t, id, page, decide } = await sendStartedThenRestarted();
      expect(await rowOf(id)).toMatchObject({ code: SEND_STARTED, relay: expect.any(String) });
      if (when === 'while the server was down') decide();

      await sendCallsStatus(t, { id }, depsOf(stallsAfter(9).openWallet));
      await vi.waitFor(() => expect(page.ids).toHaveLength(4));
      decide();

      expect(await sent(id)).toMatchObject({ callsId: CALLS_ID, relay: null, code: null });
      expect(page.ids).toEqual([...page.ids.slice(0, 2), ...page.ids.slice(0, 2)]);
      expect(page.asked()).toBe(2);
    }
  );

  it('given a stored relay session, when the same key comes again, then it answers the same link and resumes on that tab', async () => {
    const { t, key, id, url, page, decide } = await sendStartedThenRestarted({ stallAt: 1 });

    const again = await sendCalls(t, { calls: [CALL], idempotencyKey: key }, depsOf(stallsAfter(9).openWallet));

    expect(again.structuredContent?.url).toBe(url);
    decide();
    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
    expect(page.inits()).toBe(2);
  });

  it('given a page that does not replay, when the same key comes again, then it gets a new link', async () => {
    const { t, key, id, url, page } = await sendStartedThenRestarted({ replays: false, stallAt: 1 });
    expect((await rowOf(id)).relay).toBeNull();

    const again = await sendCalls(t, { calls: [CALL], idempotencyKey: key }, depsOf(stallsAfter(9).openWallet));

    expect(again.structuredContent?.url).not.toBe(url);
    expect(page.ids).toHaveLength(1);
  });

  it('given the page was closed, when the server rejoins, then the row keeps the may-have-sent marker and nothing is stored to resume', async () => {
    const { id, url, page } = await sendStartedThenRestarted();
    page.close();
    const session = new URL(url).searchParams.get('session')!;
    await vi.waitFor(() => expect(relay.sessions.get(session)?.browser).toBeUndefined());

    await resumeOwnerCalls(clients);

    await vi.waitFor(async () => expect((await rowOf(id)).relay).toBeNull());
    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED });
  });

  it('given the resumed send is refused as another request under its id, then the row keeps the may-have-sent marker and nothing is stored to resume', async () => {
    const { id, page } = await sendStartedThenRestarted();
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ calls: [{ ...CALL, value: '6' }] })
        .where(eq(ownerCalls.id, id))
    );

    await Promise.all(await resumeOwnerCalls(clients));

    await vi.waitFor(async () => expect((await rowOf(id)).relay).toBeNull());
    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED });
    expect(page.asked()).toBe(2);
  });

  it('given the owner pool is full for the account, when a tick resumes, then the lease is given back and a later tick resumes it', async () => {
    const { t, id, decide } = await sendStartedThenRestarted();
    const held: Wallet[] = [];
    const until = new Date(Date.now() + 60_000);
    for (;;) {
      const opened = await ownerRelay(84532, until, t).catch((err: unknown) => err);
      if (opened instanceof WalletBusy) break;
      held.push(opened as Wallet);
    }

    await Promise.all(await resumeOwnerCalls(clients));
    expect(await rowOf(id)).toMatchObject({ sessionUntil: null, relay: expect.any(String), resumeFailures: 0 });

    for (const wallet of held) wallet.close();
    await vi.waitFor(async () => {
      await getDb().update(ownerCalls).set({ sessionUntil: null }).where(eq(ownerCalls.id, id));
      await Promise.all(await resumeOwnerCalls(clients));
      expect((await rowOf(id)).sessionUntil).not.toBeNull();
    });
    decide();

    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
  });

  it('given two processes resume at once, then only one asks the page again', async () => {
    const { id, page, decide } = await sendStartedThenRestarted();

    await Promise.all([resumeOwnerCalls(clients), resumeOwnerCalls(clients)]);
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));
    await quiet();

    expect(page.ids).toHaveLength(4);
    expect(page.inits()).toBe(2);
    decide();
    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
  });

  it('given a resumer took the row, when the old process hears a decline, then it writes nothing and the resumed answer stands', async () => {
    const { id, page, server, decide } = await sendStartedThenRestarted();
    await resumeOwnerCalls(clients);
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));

    server.wake(Object.assign(new Error('User rejected the request'), { code: 4001 }));
    await quiet();
    expect((await rowOf(id)).state).toBe('awaiting_owner');
    decide();

    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
  });

  it('given the relay drops this server while the owner decides, then the call keeps its relay session and the next tick resumes it to sent', async () => {
    const t = await connected();
    const owned = deciding(t);
    const first = await sendCalls(t, { calls: [CALL] }, depsOf(stallsAfter(9).openWallet));
    const id = first.structuredContent!.id;
    const page = await replayingPage(first.structuredContent!.url!, owned.answer);
    await vi.waitFor(() => expect(page.ids).toHaveLength(2));

    relay.sessions.get(new URL(first.structuredContent!.url!).searchParams.get('session')!)!.cli!.close();
    await vi.waitFor(async () => expect((await rowOf(id)).sessionUntil).toBeNull());
    expect((await rowOf(id)).relay).not.toBeNull();
    await getDb()
      .update(ownerCalls)
      .set({ sessionUntil: sql`statement_timestamp() - interval '2 minutes'` })
      .where(eq(ownerCalls.id, id));

    await Promise.all(await resumeOwnerCalls(clients));
    owned.decide();

    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
  });

  it('given an old process still waiting on the page, when a resumer joins the session, then the relay drops the old socket and its run ends', async () => {
    const t = await connected();
    const owned = deciding(t);
    let ended = false;
    const openWallet: OwnerCallDeps['openWallet'] = async (...args) => {
      const wallet = await stallsAfter(9).openWallet(...args);
      return { ...wallet, run: (work, joined) => wallet.run(work, joined).finally(() => (ended = true)) };
    };
    const first = await sendCalls(t, { calls: [CALL] }, depsOf(openWallet));
    const id = first.structuredContent!.id;
    const page = await replayingPage(first.structuredContent!.url!, owned.answer);
    await vi.waitFor(() => expect(page.ids).toHaveLength(2));
    await lapse(id);

    await Promise.all(await resumeOwnerCalls(clients));

    await vi.waitFor(() => expect(ended).toBe(true));
    owned.decide();
    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
  });

  it('given a resumer took the row, when the old process hears the account refused with a code, then it writes nothing and the resumed send goes on', async () => {
    const { id, page, server, decide, signIn } = await sendStartedThenRestarted({ stallAt: 1, holdAccounts: true });
    await resumeOwnerCalls(clients);
    await vi.waitFor(() => expect(page.ids).toHaveLength(2));

    server.wake(Object.assign(new Error('refused'), { code: -32000 }));
    await quiet();
    signIn();
    decide();

    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
  });

  it('given a resumer took the row, when the old process hears the calls id first, then the row records it', async () => {
    const { id, page, server } = await sendStartedThenRestarted();
    await resumeOwnerCalls(clients);
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));

    server.wake(undefined, { id: CALLS_ID });

    expect(await sent(id)).toMatchObject({ callsId: CALLS_ID });
  });

  it('given an old replica gave the row a new link before the table guarded it and started the send there, when this server resumes the first link, then that tab is not asked to send and nothing is stored to resume', async () => {
    const { id, page } = await sendStartedThenRestarted({ stallAt: 1 });
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ walletUrl: 'http://keys.test/cli-bridge?session=new-link', code: SEND_STARTED, sessionUntil: null })
        .where(eq(ownerCalls.id, id))
    );

    await Promise.all(await resumeOwnerCalls(clients));
    await quiet();

    expect(page.ids).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_owner', code: SEND_STARTED, relay: null });
  });

  it('given the owner declined the calls, then nothing is stored to resume', async () => {
    const t = await connected();
    const first = await sendCalls(t, { calls: [CALL] }, depsOf(stallsAfter(9).openWallet));
    const id = first.structuredContent!.id;
    await replayingPage(first.structuredContent!.url!, async (method) => {
      if (method === 'eth_requestAccounts') return [t.account];
      throw Object.assign(new Error('User rejected the request'), { code: 4001 });
    });

    await vi.waitFor(async () => expect((await rowOf(id)).state).toBe('owner_declined'));
    await quiet();

    expect((await rowOf(id)).relay).toBeNull();
  });

  it('given calls whose window passed while they waited for a resume, when their status is read, then they are expired with nothing stored to resume', async () => {
    const { t, id } = await sendStartedThenRestarted();
    await withoutOwnerCallsGuard(() =>
      getDb()
        .update(ownerCalls)
        .set({ approveBy: sql`statement_timestamp() - interval '1 minute'` })
        .where(eq(ownerCalls.id, id))
    );

    await sendCallsStatus(t, { id }, depsOf(stallsAfter(9).openWallet));

    expect(await rowOf(id)).toMatchObject({ state: 'expired', relay: null });
  });

  it('given the wallet refused the account with a code, then the row keeps the code and no relay session to resume', async () => {
    const t = await connected();
    const first = await sendCalls(t, { calls: [CALL] }, depsOf(stallsAfter(9).openWallet));
    const id = first.structuredContent!.id;
    const page = await replayingPage(first.structuredContent!.url!, deciding(t, -32000).answer);

    await vi.waitFor(async () => expect((await rowOf(id)).code).toBe('wallet_error:-32000'));
    await vi.waitFor(async () => expect((await rowOf(id)).relay).toBeNull());
    await lapse(id);
    await resumeOwnerCalls(clients);
    await quiet();

    expect(page.ids).toHaveLength(1);
  });

  it('given the connection ended meanwhile, when the server rejoins, then the page is not asked again and nothing is stored to resume', async () => {
    const { t, id, page } = await sendStartedThenRestarted();
    await getDb()
      .update(connections)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(connections.id, t.connectionId));

    await resumeOwnerCalls(clients);

    await vi.waitFor(async () => expect((await rowOf(id)).relay).toBeNull());
    expect(page.ids).toHaveLength(2);
  });
});

async function waitingCall(
  over: {
    connectionId?: string;
    minutesAgo?: number;
    lapsedSeconds?: number;
    id?: string;
    sealed?: Partial<RelayResume>;
  } = {}
) {
  const id = over.id ?? randomBytes(8).toString('hex');
  const connectionId = over.connectionId ?? `c_${id}`;
  if (!over.connectionId) {
    await getDb()
      .insert(connections)
      .values({
        id: connectionId,
        status: 'active',
        account: `0x${'ab'.repeat(20)}`,
        chainId: 84532,
        clientId: 'jaw-cli',
        clientName: 'JAW CLI',
        scopes: ['wallet:read'],
        interactionUid: `i_${id}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        grantId: `g_${id}`,
        activatedAt: new Date(),
      });
  }
  await getDb()
    .insert(ownerCalls)
    .values({
      id: `oc_${id}`,
      connectionId,
      idempotencyKey: id,
      requestHash: id,
      chainId: 84532,
      account: `0x${'ab'.repeat(20)}`,
      calls: [CALL],
      walletUrl: `http://keys.test/cli-bridge?session=${id}`,
      approveBy: new Date(Date.now() + 600_000),
      code: SEND_STARTED,
      leaseHolder: id,
      sessionUntil: sql`statement_timestamp() - ${over.lapsedSeconds ?? 120} * interval '1 second'`,
      relay: over.sealed
        ? sealResume(
            config().ring,
            { session: id, key: 'zz', peer: '00', chainId: 84532, appName: 'JAW CLI', ...over.sealed },
            `oc_${id}`
          )
        : 'r1.retired.x.y',
      updatedAt: new Date(Date.now() - (over.minutesAgo ?? 1) * 60_000),
    });
  return `oc_${id}`;
}

async function waitingRequest(minutesAgo: number) {
  const call = await waitingCall();
  const id = `pr_${call.slice('oc_'.length)}`;
  const [row] = await getDb().select().from(ownerCalls).where(eq(ownerCalls.id, call));
  await getDb().update(ownerCalls).set({ relay: null }).where(eq(ownerCalls.id, call));
  await getDb()
    .insert(permissionRequests)
    .values({
      id,
      connectionId: row.connectionId,
      method: 'sign',
      chainId: 84532,
      account: row.account,
      idempotencyKey: id,
      requestHash: id,
      signKind: 'message',
      walletUrl: row.walletUrl,
      approveBy: new Date(Date.now() + 60_000),
      code: 'asked',
      payload: '{}',
      relay: 'r1.retired.x.y',
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
  return id;
}

const waitingRequests = async (ids: string[]) =>
  (
    await Promise.all(
      ids.map(async (id) => (await getDb().select().from(permissionRequests).where(eq(permissionRequests.id, id)))[0])
    )
  )
    .filter((r) => r.relay !== null)
    .map((r) => r.id);

const waiting = async (ids: string[]) =>
  (await Promise.all(ids.map(rowOf))).filter((r) => r.relay !== null).map((r) => r.id);

describe('which owner calls a resume picks', () => {
  it('given six waiting calls, then one tick resumes the five that waited longest and hands back their runs', async () => {
    const batch = randomBytes(4).toString('hex');
    const ids: string[] = [];
    for (let i = 10; i < 16; i++) ids.push(await waitingCall({ id: `${batch}${i}`, minutesAgo: 20 + i }));

    await Promise.all(await resumeOwnerCalls(clients));

    expect(await waiting(ids)).toEqual([ids[0]]);
  });

  it('given calls and permission requests waiting, then one tick resumes five in all, the longest waiting first', async () => {
    const calls: string[] = [];
    for (let i = 0; i < 4; i++) calls.push(await waitingCall({ minutesAgo: 1_000 + i }));
    const requests: string[] = [];
    for (let i = 0; i < 3; i++) requests.push(await waitingRequest(2_000 + i));

    await Promise.all(await resumeTick([requestsWaiting, callsWaiting(clients)]));

    expect(await waiting(calls)).toEqual(calls.slice(0, 2));
    expect(await waitingRequests(requests)).toEqual([]);
  });

  it('given a status read of one call, then only that call is resumed', async () => {
    const t = await connected();
    const read = await waitingCall({ connectionId: t.connectionId });
    const other = await waitingCall();

    await sendCallsStatus(t, { id: read }, depsOf(stallsAfter(9).openWallet));
    await vi.waitFor(async () => expect((await rowOf(read)).relay).toBeNull());
    await quiet();

    expect(await waiting([other])).toEqual([other]);
  });

  it('given a stored relay session that opens but holds no usable key, then it is not retried: nothing is stored to resume and no socket opens', async () => {
    const id = await waitingCall({ sealed: { key: 'zz' }, minutesAgo: 900 });

    await Promise.all(await resumeOwnerCalls(clients));

    expect((await rowOf(id)).relay).toBeNull();
    expect(relay.sessions.has(id.slice('oc_'.length))).toBe(false);
  });

  it("given a call whose rejoin keeps failing, then after five tries it is left to today's rules and frees its slot", async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const id = await waitingCall({
      minutesAgo: 3_000,
      sealed: {
        key: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
        peer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
      },
    });
    relay.refused.add(id.slice('oc_'.length));

    for (let tick = 0; tick < 5; tick++) await Promise.all(await resumeOwnerCalls(clients));

    expect(await rowOf(id)).toMatchObject({ relay: null, resumeFailures: 5, sessionUntil: null });
  });

  it('given a lease that ended inside the stall grace, then no resume takes it over until the grace passes', async () => {
    const held = await waitingCall({ lapsedSeconds: 30, minutesAgo: 600 });
    const free = await waitingCall({ lapsedSeconds: 61, minutesAgo: 600 });

    await Promise.all(await resumeOwnerCalls(clients));

    expect(await waiting([held, free])).toEqual([held]);
  });
});
