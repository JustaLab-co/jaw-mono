import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { connections, oauthPayloads } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { verifyBearer, type Tenant } from './auth';
import { connect, setTestEnv, token, walletsSettled } from './testkit';

setTestEnv();
beforeAll(useTestDb);
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
});
