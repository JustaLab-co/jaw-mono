import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, expect, it, vi } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { useTestDb } from '@/db/test-db';
import { purge } from './run';

setTestEnv();

let client: PGlite;
beforeAll(async () => {
  client = await useTestDb();
});

it('given the purge of ended add funds requests, then it reads them by their partial index', async () => {
  const query = vi.spyOn(client, 'query');
  await purge();
  const [text, params] = query.mock.calls.find(
    ([q, p]) => q.startsWith('delete from "permission_requests"') && (p as unknown[] | undefined)?.includes('add_funds')
  )!;
  query.mockRestore();

  await client.exec('set enable_seqscan = off');
  const plan = await client.query<{ 'QUERY PLAN': string }>(`explain ${text}`, params);
  await client.exec('reset enable_seqscan');

  const shown = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
  expect(shown).toContain('permission_requests_ended_add_funds_index');
  expect(shown).toMatch(/Index Cond: .*updated_at < /);
});
