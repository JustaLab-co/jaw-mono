import { expect, it } from 'vitest';
import { useTestDb } from './test-db';

it('indexes the wrap sweep, so a refresh does not scan every refresh token', async () => {
  const db = await useTestDb();
  const { rows } = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where tablename = 'oauth_payloads' and indexdef like '%consumed_at%'`
  );
  expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/consumed_at.*WHERE.*key_wrap IS NOT NULL/s);
}, 30_000);

it('bounds every statement of the app database through the role, and nothing at startup or in other databases', async () => {
  const db = await useTestDb();
  const { rows: everywhere } = await db.query<{ cfg: string[] | null }>(
    `select rolconfig as cfg from pg_roles where rolname = current_user`
  );
  const { rows: here } = await db.query<{ cfg: string[] }>(
    `select setconfig as cfg from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
      where d.datname = current_database() and s.setrole = (select oid from pg_roles where rolname = current_user)`
  );
  expect(everywhere[0].cfg ?? []).not.toContain('statement_timeout=10s');
  expect(here.flatMap((r) => r.cfg)).toContain('statement_timeout=10s');
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(`${__dirname}/client.ts`, 'utf8')).not.toMatch(/statement_timeout/);
}, 30_000);
