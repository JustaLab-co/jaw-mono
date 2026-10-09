import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { lockWaiters, statusOnceParked, TEST_PG_URL, useTestPostgres } from '@/db/test-db';
import { lockFloat } from '@/payments/refill';
import { verifyBearer, type Tenant } from './auth';
import { pageResponse, revokeFromPage, type PageDeps } from './page';
import { oauth } from './provider';
import { endConnection, revokeByGrant } from './rows';
import { connect, ISSUER, mcp, owner, pageProof, setTestEnv, verifyLocally } from './testkit';

setTestEnv();

const deps: PageDeps = {
  verify: verifyLocally,
  readPermission: async () => ({ status: 'ok', approved: true, revoked: false }),
  readFloats: async (_chainId, payers) => payers.map(() => 0n),
};

async function connected() {
  const c = await connect();
  const t = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  return { c, t };
}

/** Holds the float lock from another session, as a funding turn does, until the returned release. */
async function holdLock(connectionId: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const holding = new Promise<void>((r) => (locked = r));
  const holder = getDb().transaction(async (tx) => {
    await lockFloat(tx, connectionId, 1_000);
    locked();
    await released;
  });
  await holding;
  return () => {
    release();
    return holder;
  };
}

const stateOf = async (id: string) =>
  (
    await getDb().execute<{ status: string; grant: string; wraps: number }>(sql`
      select c.status, c.grant_id as grant,
        (select count(*)::int from oauth_payloads p where p.grant_id = c.grant_id and p.key_wrap is not null) as wraps
      from connections c where c.id = ${id}`)
  )[0];

async function waitersReach(connectionId: string, n: number) {
  for (let i = 0; i < 100 && (await lockWaiters(connectionId)) < n; i++) await new Promise((r) => setTimeout(r, 50));
}

const revocation = (refreshToken: string) =>
  oauth(
    new Request(`${ISSUER}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: 'jaw-cli' }),
    })
  );

describe.skipIf(!TEST_PG_URL)('on Postgres, given a funding turn that holds the float lock', () => {
  beforeAll(useTestPostgres);

  it('when the owner revokes on the page past the wait, then it answers 409 busy, changes nothing, and a retry after the turn ends it', async () => {
    const { c, t } = await connected();
    const before = await stateOf(t.connectionId);
    expect(before).toMatchObject({ status: 'active', wraps: 1 });
    const release = await holdLock(t.connectionId);
    try {
      const busy = await revokeFromPage(t.connectionId, await pageProof(c.signer), { ...deps, lockWaitMs: 200 });
      expect(busy).toEqual({ kind: 'busy' });
      expect(pageResponse(busy).status).toBe(409);
      expect(await stateOf(t.connectionId)).toEqual(before);
      expect((await mcp(c.access_token, { method: 'tools/list' })).status).toBe(200);
    } finally {
      await release();
    }
    const retried = await revokeFromPage(t.connectionId, await pageProof(c.signer), deps);
    expect(retried).toMatchObject({ kind: 'ok', body: { status: 'revoked' } });
    expect(await stateOf(t.connectionId)).toMatchObject({ status: 'revoked', wraps: 0 });
  });

  it('when another funding turn queues behind the waiting revoke, then that turn sees the connection ended', async () => {
    const { c, t } = await connected();
    const release = await holdLock(t.connectionId);
    const revoking = revokeFromPage(t.connectionId, await pageProof(c.signer), deps);
    await waitersReach(t.connectionId, 1);
    const nextTurn = getDb().transaction(async (tx) => {
      await lockFloat(tx, t.connectionId, 5_000);
      return (await stateOf(t.connectionId)).status;
    });
    await waitersReach(t.connectionId, 2);
    await release();
    expect((await revoking).kind).toBe('ok');
    expect(await nextTurn).toBe('revoked');
  });

  it('when a token rotation holds the connection row past the wait, then it answers busy and changes nothing', async () => {
    const { c, t } = await connected();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const rotation = getDb().transaction(async (tx) => {
      await tx.execute(sql`select id from connections where id = ${t.connectionId} for share`);
      held();
      await released;
    });
    await holding;
    try {
      const busy = await revokeFromPage(t.connectionId, await pageProof(c.signer), { ...deps, lockWaitMs: 200 });
      expect(busy).toEqual({ kind: 'busy' });
      expect((await stateOf(t.connectionId)).status).toBe('active');
    } finally {
      release();
      await rotation;
    }
  });

  it("when a stranger posts the connection's id, or the owner an unknown id, then it answers not_found without waiting", async () => {
    const { c, t } = await connected();
    const release = await holdLock(t.connectionId);
    try {
      const started = Date.now();
      expect((await revokeFromPage(t.connectionId, await pageProof(owner()), deps)).kind).toBe('not_found');
      expect((await revokeFromPage(randomUUID(), await pageProof(c.signer), deps)).kind).toBe('not_found');
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await release();
    }
  });

  it('when the owner posts a connection already revoked, then it answers ok with its view without waiting', async () => {
    const { c, t } = await connected();
    await endConnection(t.connectionId, t.account);
    const release = await holdLock(t.connectionId);
    try {
      const started = Date.now();
      expect(await revokeFromPage(t.connectionId, await pageProof(c.signer), deps)).toMatchObject({
        kind: 'ok',
        body: { id: t.connectionId, status: 'revoked' },
      });
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await release();
    }
  });

  it('when the client revokes its refresh token, then the connection ends only after the turn commits', async () => {
    const { c, t } = await connected();
    const release = await holdLock(t.connectionId);
    const revoking = revocation(c.refresh_token);
    expect(await statusOnceParked(t.connectionId)).toBe('active');
    await release();
    expect((await revoking).status).toBe(200);
    expect((await stateOf(t.connectionId)).status).toBe('revoked');
  });

  it('when the turn outlasts the wait, then ending by grant still ends the connection', async () => {
    const { t } = await connected();
    const { grant } = await stateOf(t.connectionId);
    const release = await holdLock(t.connectionId);
    try {
      await revokeByGrant(grant, 200);
      expect((await stateOf(t.connectionId)).status).toBe('revoked');
    } finally {
      await release();
    }
  });
});
