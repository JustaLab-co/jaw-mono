import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { RETRY_WINDOW_MS } from '@/connections/adapter';

// Every instance migrates at start; the lock makes concurrent starts wait
// for the first instead of racing on the same DDL.
const LOCK_ID = 0x6a61776d;

export async function runMigrations(url: string) {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    // The role's statement_timeout would cut a long migration, or a start waiting on the lock.
    await sql`set statement_timeout = 0`;
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    await migrate(drizzle(sql), { migrationsFolder: join(process.cwd(), 'drizzle') });
    await sql`delete from oauth_payloads where expires_at < now() - interval '1 day'`;
    await sql`update oauth_payloads set key_wrap = null
      where consumed_at < now() - ${RETRY_WINDOW_MS} * interval '1 millisecond' and key_wrap is not null`;
    await sql`select pg_advisory_unlock(${LOCK_ID})`;
  } finally {
    await sql.end();
  }
}
