import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

const cache = globalThis as { jawMcpDb?: Db; jawMcpHolderUrl?: string };

// Cached on globalThis so hot reloads in development reuse one pool.
export function getDb(): Db {
  if (cache.jawMcpDb) return cache.jawMcpDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  cache.jawMcpDb = drizzle(postgres(url, { connect_timeout: 2, max: 10, onnotice: () => {} }), { schema });
  cache.jawMcpHolderUrl = url;
  return cache.jawMcpDb;
}

export function setDb(db: Db, holderUrl?: string) {
  cache.jawMcpDb = db;
  cache.jawMcpHolderUrl = holderUrl;
}

export function holderUrl(): string | undefined {
  getDb();
  return cache.jawMcpHolderUrl;
}
