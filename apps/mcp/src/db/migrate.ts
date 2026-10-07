import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Every instance runs this at start; the advisory lock makes concurrent starts
// wait for the first one instead of racing on the same DDL.
const LOCK_ID = 0x6a61776d;

export async function runMigrations(url: string) {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    await migrate(drizzle(sql), { migrationsFolder: join(process.cwd(), 'drizzle') });
    await sql`select pg_advisory_unlock(${LOCK_ID})`;
  } finally {
    await sql.end();
  }
}
