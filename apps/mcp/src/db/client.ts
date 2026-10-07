import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

const cache = globalThis as { jawMcpDb?: Db };

// One pool per process, kept across hot reloads in development. Tests put an
// in-process database in the same slot.
export function getDb(): Db {
  if (cache.jawMcpDb) return cache.jawMcpDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  cache.jawMcpDb = drizzle(postgres(url, { connect_timeout: 2, max: 10, onnotice: () => {} }), { schema });
  return cache.jawMcpDb;
}

export function setDb(db: Db) {
  cache.jawMcpDb = db;
}
