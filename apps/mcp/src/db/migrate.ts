import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Every instance migrates at start; the lock makes concurrent starts wait
// for the first instead of racing on the same DDL.
const LOCK_ID = 0x6a61776d;

export async function runMigrations(url: string) {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    await migrate(drizzle(sql), { migrationsFolder: join(process.cwd(), 'drizzle') });
    await sql`delete from oauth_payloads where expires_at < now() - interval '1 day'`;
    await sql`select pg_advisory_unlock(${LOCK_ID})`;
  } finally {
    await sql.end();
  }
}
