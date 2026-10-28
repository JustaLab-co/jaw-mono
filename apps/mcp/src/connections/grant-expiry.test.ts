import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { connections, oauthPayloads } from '@/db/schema';
import { TEST_PG_URL, useTestDb, useTestPostgres } from '@/db/test-db';
import { verifyBearer, type Tenant } from './auth';
import { connect, setTestEnv, token, walletsSettled } from './testkit';

setTestEnv();
beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb);
afterEach(walletsSettled);

const tenantOf = async (accessToken: string) => (await verifyBearer(accessToken))?.extra?.tenant as Tenant;
const refresh = (refreshToken: string) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'jaw-cli' });

const rowOf = async (id: string) => (await getDb().select().from(connections).where(eq(connections.id, id)))[0];
// The adapter's own key for a stored grant.
const grantKey = (grantId: string) => createHash('sha256').update(`Grant:${grantId}`).digest('hex');
const grantRowOf = async (grantId: string) =>
  (
    await getDb()
      .select()
      .from(oauthPayloads)
      .where(eq(oauthPayloads.key, grantKey(grantId)))
  )[0];
const endGrantIn = (grantId: string, interval: string) =>
  getDb()
    .update(oauthPayloads)
    .set({
      expiresAt: sql`now() + ${interval}::interval`,
      payload: sql`jsonb_set(payload, '{exp}', to_jsonb(floor(extract(epoch from now() + ${interval}::interval))::bigint))`,
    })
    .where(eq(oauthPayloads.key, grantKey(grantId)));

describe('a connection in use outlives the 30 days its grant was first given', () => {
  it('given a connection refreshed just before its grant would end, then the next refresh still works', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const t = await tenantOf(c.access_token);
    const { grantId } = await rowOf(t.connectionId);
    expect(await grantRowOf(grantId!)).toBeDefined();
    // As if the connection was made 30 days ago, less two seconds.
    await endGrantIn(grantId!, '2 seconds');

    const first = await refresh(c.refresh_token);
    expect(first.status).toBe(200);
    expect((await rowOf(t.connectionId)).expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);

    await new Promise((r) => setTimeout(r, 2_500));
    expect(await verifyBearer(first.body.access_token)).toBeDefined();
    const second = await refresh(first.body.refresh_token);
    expect({ status: second.status, error: second.body.error }).toEqual({ status: 200, error: undefined });
  });

  it('given a refresh, then the grant lives at least as long as the connection row says', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const t = await tenantOf(c.access_token);
    const { grantId } = await rowOf(t.connectionId);
    await endGrantIn(grantId!, '1 day');
    expect((await refresh(c.refresh_token)).status).toBe(200);
    const conn = await rowOf(t.connectionId);
    const grant = await grantRowOf(grantId!);
    expect(grant.expiresAt!.getTime()).toBeGreaterThanOrEqual(conn.expiresAt.getTime() - 60_000);
    expect((grant.payload as { exp: number }).exp * 1000).toBeGreaterThanOrEqual(conn.expiresAt.getTime() - 60_000);
  });

  it('given a refresh, then the grant ends when the connection row says, not later', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const t = await tenantOf(c.access_token);
    const { grantId } = await rowOf(t.connectionId);
    expect((await refresh(c.refresh_token)).status).toBe(200);
    const conn = await rowOf(t.connectionId);
    const grant = await grantRowOf(grantId!);
    // The payload's exp is whole seconds.
    expect(Math.abs(grant.expiresAt!.getTime() - conn.expiresAt.getTime())).toBeLessThan(1_000);
    expect(Math.abs((grant.payload as { exp: number }).exp * 1000 - conn.expiresAt.getTime())).toBeLessThan(1_000);
  });

  it('given two connections, then refreshing one leaves the grant of the other as it was', async () => {
    const a = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const b = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const { grantId } = await rowOf((await tenantOf(b.access_token)).connectionId);
    await endGrantIn(grantId!, '1 day');
    const before = await grantRowOf(grantId!);

    expect((await refresh(a.refresh_token)).status).toBe(200);
    const after = await grantRowOf(grantId!);
    expect({ expiresAt: after.expiresAt, exp: (after.payload as { exp: number }).exp }).toEqual({
      expiresAt: before.expiresAt,
      exp: (before.payload as { exp: number }).exp,
    });
  });

  it('given an ended connection, then a refresh attempt does not extend its grant', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const t = await tenantOf(c.access_token);
    const { grantId } = await rowOf(t.connectionId);
    await endGrantIn(grantId!, '1 day');
    await getDb()
      .update(connections)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(connections.id, t.connectionId));
    const before = await grantRowOf(grantId!);

    expect((await refresh(c.refresh_token)).body.error).toBe('invalid_grant');
    expect((await grantRowOf(grantId!)).expiresAt).toEqual(before.expiresAt);
  });

  it('given the connection ends while its refresh is in flight, then its grant is not extended', async () => {
    const c = await connect(undefined, { scope: 'wallet:read x402:pay' });
    const t = await tenantOf(c.access_token);
    const { grantId } = await rowOf(t.connectionId);
    await endGrantIn(grantId!, '1 day');
    const before = await grantRowOf(grantId!);
    // Ends the connection as the rotation stores the new refresh token: after the
    // rotation checked the connection is active, before the expiry slides.
    await getDb().execute(
      sql.raw(`create function end_on_rotation() returns trigger language plpgsql as $$ begin
        update connections set status = 'revoked', revoked_at = now() where id = '${t.connectionId}';
        return new;
      end $$`)
    );
    await getDb().execute(
      sql.raw(`create trigger end_on_rotation after insert on oauth_payloads
        for each row when (new.model = 'RefreshToken') execute function end_on_rotation()`)
    );
    try {
      await refresh(c.refresh_token);
    } finally {
      await getDb().execute(sql.raw('drop trigger end_on_rotation on oauth_payloads'));
      await getDb().execute(sql.raw('drop function end_on_rotation()'));
    }
    expect((await rowOf(t.connectionId)).status).toBe('revoked');
    expect((await grantRowOf(grantId!)).expiresAt).toEqual(before.expiresAt);
  });
});
