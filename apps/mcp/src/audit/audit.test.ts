import type { PGlite } from '@electric-sql/pglite';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as store from '@/approvals/store';
import { connect, mcp, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { useTestDb } from '@/db/test-db';

setTestEnv();
let pg: PGlite;
beforeAll(async () => {
  pg = await useTestDb();
});

const call = (token: string, name: string, args: object) =>
  mcp(token, { method: 'tools/call', params: { name, arguments: args } });

const eventsOf = (connectionId: string) =>
  getDb().select().from(auditEvents).where(eq(auditEvents.connectionId, connectionId)).orderBy(asc(auditEvents.id));

const connectionOf = async (token: string) => {
  const { verifyBearer } = await import('@/connections/auth');
  return ((await verifyBearer(token))?.extra?.tenant as { connectionId: string }).connectionId;
};

describe('audit events', () => {
  it('records one event per tool call with its tool, outcome and request id', async () => {
    const c = await connect();
    const ok = await call(c.access_token, 'jaw_request_signature', { message: 'hello' });
    const refused = await call(c.access_token, 'jaw_request_status', { requestId: 'apr_nope' });
    expect(refused.json.result.isError).toBe(true);

    const events = await eventsOf(await connectionOf(c.access_token));
    expect(events.map((e) => [e.tool, e.outcome, e.requestId])).toEqual([
      ['jaw_request_signature', 'ok', ok.headers.get('x-request-id')],
      ['jaw_request_status', 'error', refused.headers.get('x-request-id')],
    ]);
  });

  it('records a tool that threw as an error, once', async () => {
    const c = await connect();
    vi.spyOn(store, 'insertUnderCap').mockRejectedValueOnce(new Error('boom'));
    const res = await call(c.access_token, 'jaw_request_signature', { message: 'hello' });
    expect(res.json.result.isError).toBe(true);
    const events = await eventsOf(await connectionOf(c.access_token));
    expect(events.map((e) => [e.tool, e.outcome])).toEqual([['jaw_request_signature', 'error']]);
  });

  it('records no arguments, tokens or signatures', async () => {
    const c = await connect();
    const secret = 'seller-session-0123456789abcdef';
    await call(c.access_token, 'jaw_request_signature', { message: `Bearer ${secret}` });

    const dump = JSON.stringify((await pg.query('select * from audit_events')).rows);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(c.access_token);
    expect(dump).not.toContain(c.refresh_token);
    expect(dump).not.toMatch(/0x[0-9a-f]{130}/i);
  });

  it('still answers the tool call when the event cannot be stored', async () => {
    const c = await connect();
    await pg.exec('alter table audit_events rename to audit_events_away');
    try {
      const res = await call(c.access_token, 'jaw_request_signature', { message: 'still here' });
      expect(res.json.result.isError).toBeFalsy();
      expect(res.json.result.structuredContent.status).toBe('pending');
    } finally {
      await pg.exec('alter table audit_events_away rename to audit_events');
    }
  });
});
