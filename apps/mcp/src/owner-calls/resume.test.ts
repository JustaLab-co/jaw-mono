import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { replayingPage, stallsAfter, startRelay } from '@/connections/fake-relay';
import { connect, owner, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, ownerCalls } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { resumeOwnerCalls, sendCalls, sendCallsStatus, type OwnerCallDeps } from '@/tools/owner-calls';
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

function deciding(t: Tenant, refuseAccounts?: number) {
  let decide!: () => void;
  const decided = new Promise<void>((r) => (decide = r));
  const answer = async (method: string) => {
    if (method === 'eth_requestAccounts') {
      if (refuseAccounts) throw Object.assign(new Error('refused'), { code: refuseAccounts });
      return [t.account];
    }
    await decided;
    return { id: CALLS_ID };
  };
  return { answer, decide };
}

async function sendStartedThenRestarted(opts: { replays?: boolean; stallAt?: number } = {}) {
  const t = await connected();
  const key = `k_${randomBytes(4).toString('hex')}`;
  const owned = deciding(t);
  const server = stallsAfter(opts.stallAt ?? 2);
  const first = await sendCalls(t, { calls: [CALL], idempotencyKey: key }, depsOf(server.openWallet));
  const id = first.structuredContent!.id;
  const page = await replayingPage(first.structuredContent!.url!, owned.answer, opts);
  await vi.waitFor(() => expect(page.ids).toHaveLength(opts.stallAt ?? 2));
  await lapse(id);
  return { t, key, id, url: first.structuredContent!.url!, page, server, decide: owned.decide };
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
  over: { connectionId?: string; minutesAgo?: number; lapsedSeconds?: number; id?: string } = {}
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
      walletUrl: 'http://keys.test/cli-bridge',
      approveBy: new Date(Date.now() + 600_000),
      code: SEND_STARTED,
      leaseHolder: id,
      sessionUntil: sql`statement_timestamp() - ${over.lapsedSeconds ?? 120} * interval '1 second'`,
      relay: 'r1.retired.x.y',
      updatedAt: new Date(Date.now() - (over.minutesAgo ?? 1) * 60_000),
    });
  return `oc_${id}`;
}

const waiting = async (ids: string[]) =>
  (await Promise.all(ids.map(rowOf))).filter((r) => r.relay !== null).map((r) => r.id);

describe('which owner calls a resume picks', () => {
  it('given eleven waiting calls, then one tick resumes the ten that waited longest and hands back their runs', async () => {
    const batch = randomBytes(4).toString('hex');
    const ids: string[] = [];
    for (let i = 10; i < 21; i++) ids.push(await waitingCall({ id: `${batch}${i}`, minutesAgo: 20 + i }));

    await Promise.all(await resumeOwnerCalls(clients));

    expect(await waiting(ids)).toEqual([ids[0]]);
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

  it('given a lease that ended inside the stall grace, then no resume takes it over until the grace passes', async () => {
    const held = await waitingCall({ lapsedSeconds: 30, minutesAgo: 600 });
    const free = await waitingCall({ lapsedSeconds: 61, minutesAgo: 600 });

    await Promise.all(await resumeOwnerCalls(clients));

    expect(await waiting([held, free])).toEqual([held]);
  });
});
