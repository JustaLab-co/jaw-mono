import { expect, it } from 'vitest';
import { useTestDb } from './test-db';

it('indexes the wrap sweep, so a refresh does not scan every refresh token', async () => {
  const db = await useTestDb();
  const { rows } = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where tablename = 'oauth_payloads' and indexdef like '%consumed_at%'`
  );
  expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/consumed_at.*WHERE.*key_wrap IS NOT NULL/s);
}, 30_000);
