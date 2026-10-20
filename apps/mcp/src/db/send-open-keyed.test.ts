import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';

const drizzleDir = join(__dirname, '../../drizzle');
const TAG = '0029_send_open_keyed';
const migration = readFileSync(join(drizzleDir, `${TAG}.sql`), 'utf8');

async function dbBefore0029() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-migrations-'));
  try {
    cpSync(drizzleDir, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter((e: { tag: string }) => e.tag !== TAG);
    writeFileSync(journalPath, JSON.stringify(journal));
    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: dir });
    await client.exec('set session_replication_role = replica');
    return client;
  } finally {
    rmSync(dir, { recursive: true });
  }
}

let n = 0;
async function insertSend(client: PGlite, state: 'open' | 'landed', idempotencyKey: string | null) {
  const landed = state === 'landed';
  await client.query(
    `insert into sends (id, connection_id, permission_id, chain_id, sender, idempotency_key, request_hash,
       amount, period_start, from_block, state, tx_hash, lease_until, finished_at)
     values ($1, 'c1', 'p', 1, '0xa', $2, $3, 1, 0, 0, $4, $5, now(), $6)`,
    [`s_${n++}`, idempotencyKey, idempotencyKey && 'h', state, landed ? '0xtx' : null, landed ? new Date() : null]
  );
}

const count = async (client: PGlite) =>
  (await client.query<{ n: number }>(`select count(*)::int as n from sends`)).rows[0].n;

describe('migration 0029, which keeps every open send keyed', () => {
  it('given an open send from the removed transfer tool, when it runs, then it refuses and leaves the row', async () => {
    const client = await dbBefore0029();
    await insertSend(client, 'open', null);
    await expect(client.exec(migration)).rejects.toThrow(/send_open_keyed/);
    expect(await count(client)).toBe(1);
    await insertSend(client, 'open', null);
    expect(await count(client)).toBe(2);
  });

  it('given the legacy row settled, when it runs, then it applies and keeps the settled row', async () => {
    const client = await dbBefore0029();
    await insertSend(client, 'landed', null);
    await client.exec(migration);
    expect(await count(client)).toBe(1);
  });

  it('given it ran, when an open send has no idempotency key, then the insert is refused', async () => {
    const client = await dbBefore0029();
    await client.exec(migration);
    await expect(insertSend(client, 'open', null)).rejects.toThrow(/send_open_keyed/);
    await insertSend(client, 'open', 'k1');
    expect(await count(client)).toBe(1);
  });
});
