import { randomBytes } from 'node:crypto';
import type { ChainClients, GrantedPermission } from '@jaw.id/agent';
import { eq, sql } from 'drizzle-orm';
import type { Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import type { Ask, Wallet } from '@/connections/relay';
import { connect, fakeWallet, owner, setTestEnv, walletsSettled } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { grants, permissionRequests } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import type { ReadPermission } from '@/grants/permission';
import { x402Budget } from '@/grants/store';
import { markRevoked, type LookUp } from '@/grants/revokes';
import { sign } from '@/tools/sign';
import { purge, reconcile } from './run';

setTestEnv();

const noChain: ChainClients = {
  publicClient: () => {
    throw new Error('no chain in this test');
  },
};
const noReceipt = async () => null;

const revokedIds = new Set<string>();
const read: string[] = [];
let unreadable = false;
const chain: ReadPermission = async ({ permissionId }) => {
  read.push(permissionId.toLowerCase());
  if (unreadable) return { status: 'unavailable' };
  return { status: 'ok', approved: true, revoked: revokedIds.has(permissionId.toLowerCase()) };
};
const stored = new Map<string, GrantedPermission>();
const looked: string[] = [];
let storeHangs = false;
const store: LookUp = async (id) => {
  looked.push(id.toLowerCase());
  if (storeHangs) return new Promise(() => {});
  const permission = stored.get(id.toLowerCase());
  return permission ? { permission, chainId: 8453 } : 'not_found';
};
const run = () => reconcile(noChain, new Date(), noReceipt, { readPermission: chain, lookUp: store, lookUpMs: 50 });

const signer = owner();
let t: Tenant;
let other: Tenant;
let budget: Hex;
const tenantOf = async (token: string) => (await verifyBearer(token))?.extra?.tenant as Tenant;
beforeAll(async () => {
  await (TEST_PG_URL ? useTestPostgres() : useTestDb());
  t = await tenantOf((await connect(signer)).access_token);
  other = await tenantOf((await connect(signer)).access_token);
  budget = (await x402Budget(t.connectionId))?.permissionId as Hex;
});
beforeEach(async () => {
  revokedIds.clear();
  read.length = 0;
  unreadable = false;
  stored.clear();
  looked.length = 0;
  storeHangs = false;
  await getDb().delete(permissionRequests);
  await getDb().update(grants).set({ revokedAt: null });
});

const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);
const randomId = () => `0x${randomBytes(32).toString('hex')}` as Hex;

async function row(over: Partial<typeof permissionRequests.$inferInsert>) {
  const id = `pr_${randomBytes(8).toString('hex')}`;
  await getDb()
    .insert(permissionRequests)
    .values({
      id,
      connectionId: t.connectionId,
      method: 'grant',
      chainId: t.chainId,
      account: t.account,
      walletUrl: `http://keys.test/cli-bridge?${id}`,
      approveBy: secondsFromNow(600),
      sessionUntil: secondsFromNow(20),
      ...over,
    });
  return id;
}

const rowOf = async (id: string) =>
  (await getDb().select().from(permissionRequests).where(eq(permissionRequests.id, id)))[0];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
/** Answered six minutes ago, so a run reads it. */
const unconfirmedRevoke = (permissionId: string, over: Partial<typeof permissionRequests.$inferInsert> = {}) =>
  row({ method: 'revoke', permissionId, state: 'approved', code: 'unconfirmed', updatedAt: minutesAgo(6), ...over });
const readAgainLater = () =>
  getDb()
    .update(permissionRequests)
    .set({ updatedAt: minutesAgo(6) });

describe('reconciler: owner link requests', () => {
  it('given a link past its window whose server stopped renewing it, when the reconciler runs, then it reads expired with no code', async () => {
    const id = await row({ approveBy: secondsFromNow(-1), sessionUntil: secondsFromNow(-61) });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'expired', code: null });
  });

  it('given a link past its window whose server still holds it, then it stays for that server to settle', async () => {
    const id = await row({ approveBy: secondsFromNow(-1), sessionUntil: secondsFromNow(20) });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_owner' });
  });

  it('given a waiting link with no lease, as when its server ended without settling, then it reads session_lost', async () => {
    const id = await row({ sessionUntil: null });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'expired', code: 'session_lost' });
  });

  it('given an asked link whose server stopped renewing it over a minute ago, then it reads link_lost', async () => {
    const id = await row({
      method: 'sign',
      idempotencyKey: 'k',
      requestHash: 'h',
      signKind: 'message',
      code: 'asked',
      sessionUntil: secondsFromNow(-61),
    });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'expired', code: 'link_lost' });
  });

  it('given a grant or revoke link not yet asked whose server stopped renewing it over a minute ago, then both read session_lost', async () => {
    const grant = await row({ sessionUntil: secondsFromNow(-61) });
    const revoke = await row({ method: 'revoke', permissionId: randomId(), sessionUntil: secondsFromNow(-61) });

    await run();

    expect(await rowOf(grant)).toMatchObject({ state: 'expired', code: 'session_lost' });
    expect(await rowOf(revoke)).toMatchObject({ state: 'expired', code: 'session_lost' });
  });

  it('given a link whose lease ended seconds ago, as in a database stall, or a held one, then both stay awaiting_owner', async () => {
    const stalled = await row({ sessionUntil: secondsFromNow(-10) });
    const held = await row({ method: 'revoke', permissionId: randomId(), sessionUntil: secondsFromNow(20) });

    await run();

    expect(await rowOf(stalled)).toMatchObject({ state: 'awaiting_owner', code: null });
    expect(await rowOf(held)).toMatchObject({ state: 'awaiting_owner' });
  });

  it('given an asked revoke whose server is gone, then it holds until its window ends for other connections, and ends with no code after', async () => {
    const lapsed = {
      method: 'revoke' as const,
      connectionId: other.connectionId,
      code: 'asked',
      sessionUntil: secondsFromNow(-600),
    };
    const inWindow = await row({ ...lapsed, permissionId: randomId() });
    const pastWindow = await row({
      ...lapsed,
      connectionId: t.connectionId,
      permissionId: randomId(),
      approveBy: secondsFromNow(-1),
    });

    await run();

    expect(await rowOf(inWindow)).toMatchObject({ state: 'awaiting_owner' });
    expect(await rowOf(pastWindow)).toMatchObject({ state: 'expired', code: null });
  });

  it('given an asked sign link the reconciler ended, when the connection asks to sign again, then the new link names the lost one', async () => {
    const lost = await row({
      method: 'sign',
      idempotencyKey: 'lost',
      requestHash: 'h',
      signKind: 'message',
      code: 'asked',
      sessionUntil: secondsFromNow(-61),
    });
    await run();
    const idle = async (): Promise<Wallet> => ({
      url: 'http://keys.test/cli-bridge?session=new',
      run: () => new Promise(() => {}),
      close: () => {},
    });

    const result = await sign(t, { message: 'again', idempotencyKey: 'again' }, { openWallet: idle });

    expect(result.structuredContent?.summary).toMatch(/^link_lost: .*cli-bridge\?pr_/);
    expect((await rowOf(lost)).state).toBe('expired');
  });

  const signRow = async () =>
    (await getDb().select().from(permissionRequests).where(eq(permissionRequests.connectionId, t.connectionId)))[0];

  /** A wallet whose `method` waits for `release`, answering or failing as told. */
  function slowWallet(method: string, answer: (method: string) => unknown) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const ask: Ask = async (m) => {
      if (m === 'eth_requestAccounts' && method !== m) return [signer.address];
      await held;
      return answer(m);
    };
    return { openWallet: fakeWallet(ask), release };
  }

  it('given a link whose lease ended seconds ago, as in a database stall, when its connection asks again, then the same link stays and no new one opens', async () => {
    const held = await row({
      method: 'sign',
      idempotencyKey: 'held',
      requestHash: 'h',
      signKind: 'message',
      sessionUntil: secondsFromNow(-10),
    });
    let opened = 0;
    const idle = async (): Promise<Wallet> => (
      opened++, { url: 'http://keys.test/x', run: () => new Promise(() => {}), close: () => {} }
    );

    const result = await sign(t, { message: 'other', idempotencyKey: 'other' }, { openWallet: idle });

    expect(result.content[0].text).toMatch(/^sign_in_progress: /);
    expect(opened).toBe(0);
    expect(await rowOf(held)).toMatchObject({ state: 'awaiting_owner' });
  });

  it('given the owner signs after the link was ended past its window, then the signature still settles the request', async () => {
    const wallet = slowWallet('wallet_sign', () => '0xabcdef');
    await sign(t, { message: 'late', idempotencyKey: 'late' }, wallet);
    await vi.waitFor(async () => expect((await signRow()).code).toBe('asked'));
    await getDb()
      .update(permissionRequests)
      .set({ state: 'expired', code: null })
      .where(eq(permissionRequests.connectionId, t.connectionId));

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'approved', signature: '0xabcdef' });
  });

  it('given the owner declines after the link was ended, then the request reads owner_declined', async () => {
    const wallet = slowWallet('wallet_sign', () => {
      throw Object.assign(new Error('User rejected the request'), { code: 4001 });
    });
    await sign(t, { message: 'no', idempotencyKey: 'no' }, wallet);
    await vi.waitFor(async () => expect((await signRow()).code).toBe('asked'));
    await getDb()
      .update(permissionRequests)
      .set({ state: 'expired', code: 'link_lost' })
      .where(eq(permissionRequests.connectionId, t.connectionId));

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'owner_declined' });
  });

  it('given the reconciler ended a link before its wallet session failed, then the failure does not replace session_lost', async () => {
    const wallet = slowWallet('eth_requestAccounts', () => {
      throw new Error('the wallet session ended');
    });
    await sign(t, { message: 'gone', idempotencyKey: 'gone' }, wallet);
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: secondsFromNow(-61) })
      .where(eq(permissionRequests.connectionId, t.connectionId));
    await run();

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'expired', code: 'session_lost' });
  });

  it('given a session whose lease lapsed seconds ago in a stall, when the wallet answers, then it still asks the owner and the signature settles', async () => {
    const wallet = slowWallet('eth_requestAccounts', (m) =>
      m === 'eth_requestAccounts' ? [signer.address] : '0xbeef'
    );
    await sign(t, { message: 'stall', idempotencyKey: 'stall' }, wallet);
    await getDb()
      .update(permissionRequests)
      .set({ sessionUntil: secondsFromNow(-10) })
      .where(eq(permissionRequests.connectionId, t.connectionId));

    wallet.release();
    await walletsSettled();

    expect(await signRow()).toMatchObject({ state: 'approved', signature: '0xbeef' });
  });

  it('given more unconfirmed revokes than a batch, then one run reads at most fifty', async () => {
    for (let i = 0; i < 51; i++) await unconfirmedRevoke(randomId());

    await run();

    expect(looked).toHaveLength(50);
  });

  it('given the permission store never answers, then the run still ends and the revoke stays unconfirmed', async () => {
    storeHangs = true;
    const id = await unconfirmedRevoke(randomId());

    const report = await run();

    expect(report.links.revoked).toBe(0);
    expect(await rowOf(id)).toMatchObject({ code: 'unconfirmed' });
  });

  it('given an unconfirmed revoke the chain now shows, then the request settles and the grant reads revoked', async () => {
    const id = await unconfirmedRevoke(budget);
    revokedIds.add(budget.toLowerCase());

    const report = await run();

    expect(await rowOf(id)).toMatchObject({ state: 'approved', code: null });
    const [grant] = await getDb().select().from(grants).where(eq(grants.permissionId, budget));
    expect(grant.revokedAt).not.toBeNull();
    expect(report.links.revoked).toBe(1);
  });

  it('given an unconfirmed revoke whose grant already reads revoked, then the request settles without reading the chain', async () => {
    const id = await unconfirmedRevoke(budget);
    await getDb().update(grants).set({ revokedAt: new Date() }).where(eq(grants.permissionId, budget));

    await run();

    expect(read).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ code: null });
  });

  it('given an unconfirmed revoke of a permission this server holds no grant for, then it reads the store copy on chain', async () => {
    const theirs = randomId();
    const [mine] = await getDb().select().from(grants).where(eq(grants.permissionId, budget));
    stored.set(theirs.toLowerCase(), mine.permission as GrantedPermission);
    const id = await unconfirmedRevoke(theirs);
    revokedIds.add(theirs.toLowerCase());

    await run();

    expect(read).toContain(theirs.toLowerCase());
    expect(await rowOf(id)).toMatchObject({ code: null });
  });

  it('given an unconfirmed revoke the chain does not show or cannot read, then it stays unconfirmed', async () => {
    const id = await unconfirmedRevoke(budget);

    await run();
    unreadable = true;
    revokedIds.add(budget.toLowerCase());
    await readAgainLater();
    await run();

    expect(read).toEqual([budget.toLowerCase(), budget.toLowerCase()]);
    expect(await rowOf(id)).toMatchObject({ state: 'approved', code: 'unconfirmed' });
    const [grant] = await getDb().select().from(grants).where(eq(grants.permissionId, budget));
    expect(grant.revokedAt).toBeNull();
  });

  it("given an unconfirmed revoke asked from another account than the grant's, then that grant is not read for it", async () => {
    const id = await unconfirmedRevoke(budget, { account: `0x${randomBytes(20).toString('hex')}` });
    revokedIds.add(budget.toLowerCase());

    await run();

    expect(read).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ code: 'unconfirmed' });
  });

  it('given an unconfirmed revoke asked over a day ago, then it is no longer read and ends failed as revoke_not_seen', async () => {
    const id = await unconfirmedRevoke(budget, { createdAt: minutesAgo(25 * 60) });

    await run();

    expect(read).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ state: 'failed', code: 'revoke_not_seen' });
  });

  it('given a revoke settled over a day ago, then giving up on unconfirmed ones leaves it settled', async () => {
    const id = await unconfirmedRevoke(budget, { code: null, createdAt: minutesAgo(25 * 60) });

    await run();

    expect(await rowOf(id)).toMatchObject({ state: 'approved', code: null });
  });

  it('given a revoke that ended revoke_not_seen, when the chain later shows it revoked, then marking it revoked settles the request', async () => {
    const id = await unconfirmedRevoke(budget, { createdAt: minutesAgo(25 * 60) });
    await run();

    expect(await markRevoked(budget)).toBe(1);

    expect(await rowOf(id)).toMatchObject({ state: 'approved', code: null });
  });

  it('given an unconfirmed revoke read moments ago, when two runs start together and again right after, then the chain is read once', async () => {
    await unconfirmedRevoke(budget);

    await Promise.all([run(), run()]);
    await run();

    expect(read).toEqual([budget.toLowerCase()]);
  });

  it.skipIf(!TEST_PG_URL)(
    'given another run holds one unconfirmed revoke, then this run passes it by and reads the rest',
    async () => {
      const id = await unconfirmedRevoke(budget);
      const free = randomId();
      await unconfirmedRevoke(free);

      await getDb().transaction(async (tx) => {
        await tx.execute(sql`select id from permission_requests where id = ${id} for update`);
        await run();
      });

      expect(read).toEqual([]);
      expect(looked).toEqual([free.toLowerCase()]);
    }
  );

  it('given two connections waiting on the same unconfirmed revoke, then one read settles both', async () => {
    const mine = await unconfirmedRevoke(budget);
    const theirs = await unconfirmedRevoke(budget, { connectionId: other.connectionId });
    revokedIds.add(budget.toLowerCase());

    const report = await run();

    expect(read).toEqual([budget.toLowerCase()]);
    expect(report.links.revoked).toBe(2);
    expect(await rowOf(mine)).toMatchObject({ code: null });
    expect(await rowOf(theirs)).toMatchObject({ code: null });
  });

  it('given sign requests that ended over a week ago, when the purge runs, then only those are deleted', async () => {
    const sign = { method: 'sign' as const, requestHash: 'h', signKind: 'message' as const };
    const weekAgo = new Date(Date.now() - 8 * 86_400_000);
    const old = await row({ ...sign, idempotencyKey: 'old', state: 'approved', signature: '0x01', updatedAt: weekAgo });
    const recent = await row({ ...sign, idempotencyKey: 'recent', state: 'approved', signature: '0x02' });
    const waiting = await row({ ...sign, idempotencyKey: 'waiting', updatedAt: weekAgo });
    const oldGrant = await row({ state: 'owner_declined', updatedAt: weekAgo });

    await purge();

    expect(await rowOf(old)).toBeUndefined();
    expect(await rowOf(recent)).toBeDefined();
    expect(await rowOf(waiting)).toBeDefined();
    expect(await rowOf(oldGrant)).toBeDefined();
    const [{ n }] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(permissionRequests)
      .where(eq(permissionRequests.method, 'sign'));
    expect(n).toBe(2);
  });

  it('given a sign request purged a week after it ended, when its key is sent again, then a new link opens for the owner', async () => {
    const old = { method: 'sign' as const, idempotencyKey: 'week-old', requestHash: 'h', signKind: 'message' as const };
    await row({ ...old, state: 'approved', signature: '0x01', updatedAt: new Date(Date.now() - 8 * 86_400_000) });
    const idle = async (): Promise<Wallet> => ({
      url: 'http://keys.test/cli-bridge?session=new',
      run: () => new Promise(() => {}),
      close: () => {},
    });
    const ask = () => sign(t, { message: 'again', idempotencyKey: 'week-old' }, { openWallet: idle });

    const before = await ask();
    await purge();
    const after = await ask();

    expect(before.content[0].text).toMatch(/^idempotency_conflict: /);
    expect(after.structuredContent).toMatchObject({
      state: 'awaiting_owner',
      url: 'http://keys.test/cli-bridge?session=new',
    });
  });
});
