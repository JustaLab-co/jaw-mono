import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { assertClean } from './lib/checks.mjs';
import { connect, revoke, send, tool } from './lib/client.mjs';
import { down, PG_URL, up, waitFor } from './lib/stack.mjs';

let stack;
before(async () => {
  stack = await up({ label: 'pool' });
});
after(() => down());

const timed = async (work) => {
  const started = Date.now();
  const value = await work();
  return { ms: Date.now() - started, value };
};

test('other tenants still get status, revoke and health while six connections queue disconnects', async (t) => {
  const busy = [];
  for (let i = 0; i < 6; i++) busy.push(await connect());
  const other = await connect();
  const victim = await connect();
  const ids = await Promise.all(
    busy.map(async (b) => (await stack.db`select id from connections where account = ${b.owner.address}`)[0].id)
  );
  const holder = postgres(PG_URL, { max: 1, connection: { application_name: 'chaos-holder' }, onnotice: () => {} });
  const reserved = await holder.reserve();
  await reserved`begin`;
  for (const id of ids) await reserved`select pg_advisory_xact_lock(hashtext(${`refill:${id}`}))`;

  const queued = busy.flatMap((b) => [1, 2].map(() => tool(b.access_token, 'jaw_disconnect', {}, 'mcp1')));
  await waitFor('twelve disconnects waiting on the float lock', async () => {
    const [{ n }] = await stack.db`select count(*)::int as n from pg_stat_activity
      where datname = 'mcp' and wait_event_type = 'Lock' and application_name <> 'chaos-holder'`;
    return n >= 12;
  });
  const [status, revoked, health] = await Promise.all([
    timed(() => tool(other.access_token, 'jaw_status', {}, 'mcp1')),
    timed(() => revoke(victim.refresh_token, 'mcp1')),
    timed(() => send('/api/health', { replica: 'mcp1' })),
  ]);
  await reserved`rollback`;
  reserved.release();
  await holder.end();
  const answers = await Promise.all(queued);
  t.diagnostic(`status ${status.ms} ms, revoke ${revoked.ms} ms, health ${health.ms} ms`);

  assert.deepEqual(
    {
      status: status.value.status === 200 && !status.value.result?.isError,
      revoke: revoked.value.status,
      health: health.value.status,
      slowest: Math.max(status.ms, revoked.ms, health.ms) < 2_000,
    },
    { status: true, revoke: 200, health: 200, slowest: true },
    'status, revoke and health answer within 2 s while queued disconnects outnumber the pool'
  );
  assert.ok(
    answers.every((a) => a.status === 200),
    'every queued disconnect got an answer'
  );
  await assertClean(stack, { secrets: [...busy.map((b) => b.access_token), other.access_token, victim.refresh_token] });
});
