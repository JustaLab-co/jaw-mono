import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

/** Where float lock sessions connect. PGlite has one session, so its holds queue in process. */
export type FloatHolder = { url: string } | 'pglite';

const cache = globalThis as { jawMcpDb?: Db; jawMcpHolder?: FloatHolder };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

// Cached on globalThis so hot reloads in development reuse one pool.
export function getDb(): Db {
  if (cache.jawMcpDb) return cache.jawMcpDb;
  cache.jawMcpDb = drizzle(postgres(databaseUrl(), { connect_timeout: 2, max: 10, onnotice: () => {} }), { schema });
  return cache.jawMcpDb;
}

export function setDb(db: Db, holder: FloatHolder) {
  cache.jawMcpDb = db;
  cache.jawMcpHolder = holder;
}

export function floatHolder(): FloatHolder {
  return cache.jawMcpHolder ?? { url: databaseUrl() };
}
