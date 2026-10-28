// What every scenario checks after it: rows left in a state nothing resolves,
// locks or transactions left open, metrics, and logs that leak.
import assert from 'node:assert/strict';
import { logs, waitFor } from './stack.mjs';
import { metrics } from './client.mjs';

/** Backends of the app (not this harness) still inside a transaction, and advisory locks held or awaited. */
export async function openWork(db) {
  const [{ tx }] = await db`select count(*)::int as tx from pg_stat_activity
    where datname = 'mcp' and pid <> pg_backend_pid() and state like 'idle in transaction%'
      and application_name <> 'chaos-holder'`;
  const [{ locks }] = await db`select count(*)::int as locks from pg_locks where locktype = 'advisory'`;
  return { tx, locks };
}

export async function settled(db, ms = 20_000) {
  await waitFor(
    'no open transaction or advisory lock',
    async () => {
      const w = await openWork(db);
      return w.tx === 0 && w.locks === 0;
    },
    ms
  );
}

/** Used refresh tokens whose successor was never stored: a rotation that committed half. */
export async function brokenTokens(db) {
  const [{ orphan }] = await db`select count(*)::int as orphan from oauth_payloads t
    where t.model = 'RefreshToken' and t.consumed_at is not null
      and not exists (select 1 from oauth_payloads s where s.key = t.successor_key)`;
  return { orphan };
}

const SQL_TEXT = /\b(select|insert into|update|delete from)\b[^"]*\b(from|set|values|where)\b/i;

/**
 * Lines of the replica logs that carry a secret or SQL. `secrets` are values
 * that must never appear: sealing key, cron secret, tokens the test minted.
 */
export async function leaks(ids, secrets) {
  const found = [];
  for (const id of ids) {
    for (const line of (await logs(id)).split('\n')) {
      if (secrets.some((s) => s && line.includes(s))) found.push(`${id}: secret in ${line.slice(0, 120)}`);
      else if (SQL_TEXT.test(line) || line.includes('postgres://')) found.push(`${id}: ${line.slice(0, 200)}`);
    }
  }
  return found;
}

export async function errorLines(id) {
  return (await logs(id)).split('\n').filter((l) => l.includes('"level":"error"'));
}

/** The common tail of a scenario. */
export async function assertClean(stack, { secrets = [] } = {}) {
  await settled(stack.db);
  assert.deepEqual(await brokenTokens(stack.db), { orphan: 0 }, 'no refresh token consumed without a stored successor');
  const m = await metrics(stack.secret, stack.specs[0].id);
  assert.equal(m.status, 200, 'metrics answer');
  assert.equal(m.values.jaw_mcp_payments_backlog ?? 0, 0, 'no reconciler backlog');
  const leaked = await leaks(
    stack.specs.map((s) => s.id),
    [stack.secret, ...stack.specs.map((s) => s.env.JAW_MCP_SEALING_KEYS), ...secrets]
  );
  assert.deepEqual(leaked, [], 'no secret or SQL in the logs');
  return m;
}
