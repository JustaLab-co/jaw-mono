import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { replayingPage, stallsAfter, startRelay } from '@/connections/fake-relay';
import { approvedOnChain, connect, owner, setTestEnv, walletAnswers, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, grants, permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { grantPermissions, grantWork } from '@/tools/grant-permissions';
import { resumeSign, sign } from '@/tools/sign';
import { checkGranted, recordGrant, type GrantRequest } from './permission';
import { resumeOpen, type PermissionRequestRow } from './requests';
import { LIVE_GRANTS_PER_CONNECTION } from './store';

const relay = await startRelay();
setTestEnv();
process.env.JAW_RELAY_URL = relay.url;
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterAll(() => relay.close());

type Signer = ReturnType<typeof owner>;

async function connected() {
  const signer = owner();
  const c = await connect(signer);
  await walletsSettled();
  return { signer, t: (await verifyBearer(c.access_token))?.extra?.tenant as Tenant };
}

const rowOf = async (id: string) =>
  (await getDb().select().from(permissionRequests).where(eq(permissionRequests.id, id)))[0];
const signRow = async (t: Tenant, key: string) =>
  (await getDb().select().from(permissionRequests).where(eq(permissionRequests.idempotencyKey, key))).find(
    (r) => r.connectionId === t.connectionId
  )!;
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

function deciding(signer: Signer, message: string) {
  let decide!: () => void;
  const decided = new Promise<void>((r) => (decide = r));
  const answer = async (method: string) => {
    if (method === 'eth_requestAccounts') return [signer.address];
    await decided;
    return signer.signMessage({ message });
  };
  return { answer, decide };
}

async function askedThenRestarted(message = 'sign in', opts: { replays?: boolean } = {}) {
  const { signer, t } = await connected();
  const key = `k_${randomBytes(4).toString('hex')}`;
  const owned = deciding(signer, message);
  const server = stallsAfter(2);
  const first = await sign(t, { message, idempotencyKey: key }, { openWallet: server.openWallet });
  const page = await replayingPage(first.structuredContent!.url!, owned.answer, opts);
  await vi.waitFor(() => expect(page.ids).toHaveLength(2));
  const row = await signRow(t, key);
  await lapse(row.id);
  return { signer, t, key, message, row, page, server, decide: owned.decide };
}

const resumeSigns = () => resumeOpen({ sign: resumeSign });

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
    await new Promise((r) => setTimeout(r, 300));

    expect(page.ids).toHaveLength(2);
  });

  it('given two processes resume at once, then only one asks the page again', async () => {
    const { row, page, decide } = await askedThenRestarted();

    await Promise.all([resumeSigns(), resumeSigns()]);
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));
    await new Promise((r) => setTimeout(r, 500));

    expect(page.ids).toHaveLength(4);
    expect(page.inits()).toBe(2);
    decide();
    expect(await settled(row.id)).toMatchObject({ state: 'approved' });
  });

  it('given a resumer took the lease, when the old process wakes up and the owner declined there, then it writes nothing and the resumed answer stands', async () => {
    const { row, page, server, decide } = await askedThenRestarted();
    await resumeSigns();
    await vi.waitFor(() => expect(page.ids).toHaveLength(4));

    server.wake(Object.assign(new Error('User rejected the request'), { code: 4001 }));
    await new Promise((r) => setTimeout(r, 300));
    expect((await rowOf(row.id)).state).toBe('awaiting_owner');
    decide();

    expect(await settled(row.id)).toMatchObject({ state: 'approved' });
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

describe('a grant request whose server restarted', () => {
  it('given the grant the owner approved is already recorded and fills the connection, when the server rejoins, then the row ends approved', async () => {
    const { signer, t } = await connected();
    let answered: Record<string, unknown> | undefined;
    const honest = walletAnswers(signer);
    const server = stallsAfter(1);
    await grantPermissions(
      t,
      { calls: [{ target: `0x${'12'.repeat(20)}`, functionSignature: 'transfer(address,uint256)' }] },
      { openWallet: server.openWallet, readPermission: approvedOnChain }
    );
    const [row] = await getDb()
      .select()
      .from(permissionRequests)
      .where(eq(permissionRequests.connectionId, t.connectionId));
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

    await resumeOpen({ grant: grantWork(approvedOnChain) });

    expect(await settled(row.id)).toMatchObject({ state: 'approved', permissionId: answered!.permissionId });
    expect(page.asked()).toBe(1);
    const [{ n }] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(grants)
      .where(eq(grants.permissionId, answered!.permissionId as Hex));
    expect(n).toBe(1);
  });
});

describe('the resumes one tick starts', () => {
  it('given eleven resumable requests, then one tick starts ten and the next starts the last', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await resumableRow());
    const ended = async () =>
      (await Promise.all(ids.map(rowOf))).filter((r: PermissionRequestRow) => r.state !== 'awaiting_owner').length;

    await resumeSigns();
    await vi.waitFor(async () => expect(await ended()).toBe(10));

    await resumeSigns();
    await vi.waitFor(async () => expect(await ended()).toBe(11));
  });
});

async function resumableRow(): Promise<string> {
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
      interactionUid: `i_${id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      grantId: `g_${id}`,
      activatedAt: new Date(),
    });
  await getDb()
    .insert(permissionRequests)
    .values({
      id: `pr_${id}`,
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
      relay: 'r1.retired.x.y',
    });
  return `pr_${id}`;
}
