import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

type Db = ReturnType<typeof open>;

const cache = globalThis as { jawMcpDb?: Db };

function open() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { connect_timeout: 2, max: 10, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}

// One pool per process, kept across hot reloads in development.
export function getDb(): Db {
  cache.jawMcpDb ??= open();
  return cache.jawMcpDb;
}
