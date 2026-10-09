import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { getDb, setDb, type Db } from './client';
import * as schema from './schema';

const migrationsFolder = join(__dirname, '../../drizzle');

export async function useTestDb(): Promise<PGlite> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  setDb(db as unknown as Db);
  return client;
}

/** Set by the test-pg target. PGlite runs one transaction at a time, so lock races need this. */
export const TEST_PG_URL = process.env.MCP_TEST_DATABASE_URL;

/** A fresh database per test file on TEST_PG_URL. Returns the teardown that drops it. */
export async function useTestPostgres(): Promise<() => Promise<void>> {
  if (!TEST_PG_URL) throw new Error('MCP_TEST_DATABASE_URL is not set');
  const name = `mcp_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(TEST_PG_URL, { connect_timeout: 5, max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`).catch(async (e) => {
    await admin.end();
    throw e;
  });
  const url = new URL(TEST_PG_URL);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 10, onnotice: () => {} });
  const teardown = async () => {
    await client.end();
    await admin.unsafe(`drop database ${name} with (force)`);
    await admin.end();
  };
  const db = drizzlePg(client, { schema });
  await migratePg(db, { migrationsFolder }).catch(async (e) => {
    await teardown();
    throw e;
  });
  setDb(db);
  return teardown;
}

/**
 * Points getDb at a fresh pool on the test database whose sessions start with this
 * role statement_timeout, as migration 0011 sets it. Returns the restore.
 */
export async function withRoleStatementTimeout(value: string): Promise<() => Promise<void>> {
  const previous = getDb();
  const [{ db }] = await previous.execute<{ db: string }>(sql`select current_database() as db`);
  const url = new URL(TEST_PG_URL as string);
  url.pathname = `/${db}`;
  const setRole = (v: string) =>
    previous.execute(
      sql.raw(`do $$ begin execute format('alter role %I in database %I set statement_timeout = %L',
        current_user, current_database(), '${v}'); end $$`)
    );
  const probe = postgres(url.href, { max: 1 });
  const [{ statement_timeout: before }] = await probe`show statement_timeout`;
  await probe.end();
  await setRole(value);
  const client = postgres(url.href, { max: 10, onnotice: () => {} });
  setDb(drizzlePg(client, { schema }));
  return async () => {
    setDb(previous);
    await client.end();
    await setRole(before);
  };
}

/** Sessions waiting on this connection's float lock. The int4 key fills objid, sign extended into classid. */
export async function lockWaiters(connectionId: string): Promise<number> {
  const [{ n }] = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n from pg_locks
    where locktype = 'advisory' and not granted
      and database = (select oid from pg_database where datname = current_database())
      and ((classid::bigint << 32) | objid::bigint) = hashtext(${`refill:${connectionId}`})`);
  return n;
}

/** The connection's status once something waits on its float lock, or once it ended without waiting. */
export async function statusOnceParked(connectionId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const parked = (await lockWaiters(connectionId)) > 0;
    const [row] = await getDb()
      .select({ status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, connectionId));
    if (parked || row.status === 'revoked') return row.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('nothing waited on the float lock and the connection did not end');
}
