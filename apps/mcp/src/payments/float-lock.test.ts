import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import { TEST_PG_URL, useTestPostgres } from '@/db/test-db';
import { FloatBusy, FloatLost, MAX_HOLDS, withFloat, type FloatHold } from './float-lock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!TEST_PG_URL)('on Postgres, the float lock', () => {
  let probe: postgres.Sql;
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await useTestPostgres();
    const [{ db }] = await getDb().execute<{ db: string }>(sql`select current_database() as db`);
    const url = new URL(TEST_PG_URL as string);
    url.pathname = `/${db}`;
    probe = postgres(url.href, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await probe.end();
    await teardown();
  });

  const activity = async () =>
    (
      await probe`
        select count(*) filter (where state like 'idle in transaction%')::int as idle,
          count(*) filter (where state like 'idle in transaction%' and pid in
            (select pid from pg_locks where locktype = 'advisory' and granted))::int as holding,
          count(*) filter (where wait_event_type = 'Lock')::int as waiting,
          count(*)::int as sessions
        from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`
    )[0];

  async function holding(ids: string[]) {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const holds: FloatHold[] = [];
    const done = ids.map((id) =>
      withFloat(id, 5_000, async (hold) => {
        holds.push(hold);
        await gate;
      })
    );
    for (let i = 0; i < 250 && holds.length < ids.length; i++) await sleep(20);
    expect(holds).toHaveLength(ids.length);
    return () => {
      open();
      return Promise.all(done);
    };
  }

  it('given ten holds open, then only their own sessions sit in a transaction, each holding its lock', async () => {
    const release = await holding(Array.from({ length: 10 }, () => randomUUID()));
    try {
      expect(await activity()).toMatchObject({ idle: 10, holding: 10, waiting: 0 });
    } finally {
      await release();
    }
  });

  it('given a hold whose session is terminated, then the work learns it lost the float and the next hold locks at once', async () => {
    const id = randomUUID();
    let lost: unknown;
    await withFloat(id, 5_000, async (hold) => {
      await probe`select pg_terminate_backend(pid) from pg_locks
        where locktype = 'advisory' and granted
          and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${id}`})`;
      for (let i = 0; i < 100 && !lost; i++) {
        try {
          hold.assertHeld();
          await sleep(20);
        } catch (err) {
          lost = err;
        }
      }
    });
    expect(lost).toBeInstanceOf(FloatLost);
    const started = Date.now();
    await withFloat(id, 1_000, async () => undefined);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('given the lock held, when a wait shorter than the connect asks for it, then it is busy, never canceled', async () => {
    const id = randomUUID();
    const release = await holding([id]);
    try {
      let ran = false;
      const err = await withFloat(id, 1, async () => {
        ran = true;
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FloatBusy);
      expect(ran).toBe(false);
    } finally {
      await release();
    }
  });

  it('given every hold of this replica taken, when one more asks with a short wait, then it is busy and opens no session', async () => {
    const release = await holding(Array.from({ length: MAX_HOLDS }, () => randomUUID()));
    try {
      const before = await activity();
      const extra = withFloat(randomUUID(), 300, async () => 'ran').catch((e: unknown) => e);
      await sleep(150);
      const during = await activity();
      expect(await extra).toBeInstanceOf(FloatBusy);
      expect(during.sessions).toBe(before.sessions);
    } finally {
      await release();
    }
  });
});
