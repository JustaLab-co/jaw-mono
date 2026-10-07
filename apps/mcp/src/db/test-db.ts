import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { setDb, type Db } from './client';
import * as schema from './schema';

export async function useTestDb(): Promise<PGlite> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: join(__dirname, '../../drizzle') });
  setDb(db as unknown as Db);
  return client;
}
