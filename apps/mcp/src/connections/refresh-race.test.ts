import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db/client';
import { TEST_PG_URL, useTestPostgres } from '@/db/test-db';
import { verifyBearer, type Tenant } from './auth';
import { findActive } from './rows';
import { connect, setTestEnv, token } from './testkit';

setTestEnv();

const refresh = (refreshToken: string) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'jaw-cli' });

async function connected() {
  const c = await connect();
  const { connectionId } = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  return { c, connectionId };
}

const liveRefreshTokens = async (connectionId: string) =>
  (
    await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from oauth_payloads p join connections c on p.grant_id = c.grant_id
      where c.id = ${connectionId} and p.model = 'RefreshToken' and p.consumed_at is null`)
  )[0].n;

const lockWaiters = async () =>
  (
    await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`)
  )[0].n;

/**
 * Starts the refreshes while the connection's refresh tokens are locked, and lets
 * them go only once every one waits on that lock, so each round races at the rotation.
 */
async function racing<T>(connectionId: string, refreshes: (() => Promise<T>)[]): Promise<T[]> {
  let answers!: Promise<T[]>;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      select p.key from oauth_payloads p join connections c on p.grant_id = c.grant_id
      where c.id = ${connectionId} and p.model = 'RefreshToken' for update of p`);
    answers = Promise.all(refreshes.map((r) => r()));
    await vi.waitFor(async () => expect(await lockWaiters()).toBe(refreshes.length), { timeout: 20_000 });
  });
  return answers;
}

describe.skipIf(!TEST_PG_URL)('on Postgres, given one refresh token', () => {
  beforeAll(useTestPostgres);

  it.each([
    [2, 5],
    [3, 5],
  ])(
    'when %i refreshes with it run concurrently, %i rounds in a row, then all 200 with the same refresh token and the connection stays active',
    async (n, rounds) => {
      const { c, connectionId } = await connected();
      let current = c.refresh_token;
      for (let i = 0; i < rounds; i++) {
        const answers = await racing(
          connectionId,
          Array.from({ length: n }, () => () => refresh(current))
        );
        expect(answers.map((a) => a.status)).toEqual(Array(n).fill(200));
        expect(new Set(answers.map((a) => a.body.refresh_token)).size).toBe(1);
        current = answers[0].body.refresh_token;
      }
      expect(await liveRefreshTokens(connectionId)).toBe(1);
      expect(await findActive(connectionId)).toBeDefined();
    }
  );

  it('when its response is lost and two retries run concurrently, 5 rounds in a row, then both 200 with the lost refresh token', async () => {
    const { c, connectionId } = await connected();
    let current = c.refresh_token;
    for (let i = 0; i < 5; i++) {
      const lost = (await refresh(current)).body.refresh_token;
      const retries = await racing(connectionId, [() => refresh(current), () => refresh(current)]);
      expect(retries.map((r) => [r.status, r.body.refresh_token])).toEqual([
        [200, lost],
        [200, lost],
      ]);
      current = lost;
    }
    expect(await liveRefreshTokens(connectionId)).toBe(1);
    expect(await findActive(connectionId)).toBeDefined();
  });
});
