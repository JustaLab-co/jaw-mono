import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { setDb, type Db } from './client';
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
