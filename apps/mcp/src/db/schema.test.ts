import { expect, it } from 'vitest';
import { useTestDb } from './test-db';

it('indexes the wrap sweep, so a refresh does not scan every refresh token', async () => {
  const db = await useTestDb();
  const { rows } = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where tablename = 'oauth_payloads' and indexdef like '%consumed_at%'`
  );
  expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/consumed_at.*WHERE.*key_wrap IS NOT NULL/s);
}, 30_000);

it('bounds every statement through the role, which a transaction-mode pooler keeps, and sends no startup parameter', async () => {
  const db = await useTestDb();
  const { rows } = await db.query<{ setting: string }>(
    `select setting from pg_settings where name = 'statement_timeout'`
  );
  const { rows: role } = await db.query<{ cfg: string[] | null }>(
    `select rolconfig as cfg from pg_roles where rolname = current_user`
  );
  expect(role[0].cfg ?? []).toContain('statement_timeout=10s');
  expect(rows).toHaveLength(1);
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(`${__dirname}/client.ts`, 'utf8')).not.toMatch(/statement_timeout/);
}, 30_000);
