import type { PGlite } from '@electric-sql/pglite';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as store from '@/approvals/store';
import * as payments from '@/payments/pay';
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

  it('records a refused payment by its refusal code, not as ok', async () => {
    const c = await connect();
    const structuredContent = {
      paymentId: 'pay_1',
      idempotencyKey: 'k',
      state: 'failed',
      kind: 'refused',
      httpStatus: 402,
      refusal: { code: 'budget_exhausted', next: 'jaw_request_budget' },
      moneyMoved: false,
      summary: 'Not paid: budget_exhausted. Nothing was sent.',
    } as const;
    vi.spyOn(payments, 'pay').mockResolvedValueOnce({
      content: [{ type: 'text', text: structuredContent.summary }],
      structuredContent,
    });
    await call(c.access_token, 'jaw_pay_and_fetch', { url: 'https://seller.example.test/x' });

    const events = await eventsOf(await connectionOf(c.access_token));
    expect(events.map((e) => [e.tool, e.outcome])).toEqual([['jaw_pay_and_fetch', 'budget_exhausted']]);
  });

  it('records a payment that may have reached the seller as unknown, not as refused', async () => {
    const c = await connect();
    const answer = (state: 'signed' | 'unknown', code: string) => {
      const structuredContent = {
        paymentId: 'pay_1',
        idempotencyKey: 'k',
        state,
        kind: 'failed',
        httpStatus: null,
        refusal: { code },
        moneyMoved: false,
        summary: 'A payment was sent and no answer came back.',
      } as const;
      return { content: [{ type: 'text' as const, text: structuredContent.summary }], structuredContent };
    };
    vi.spyOn(payments, 'pay')
      .mockResolvedValueOnce(answer('signed', 'no_response'))
      .mockResolvedValueOnce(answer('unknown', 'seller_error'));
    await call(c.access_token, 'jaw_pay_and_fetch', { url: 'https://seller.example.test/x' });
    await call(c.access_token, 'jaw_pay_and_fetch', { url: 'https://seller.example.test/x' });

    const events = await eventsOf(await connectionOf(c.access_token));
    expect(events.map((e) => e.outcome)).toEqual(['unknown', 'unknown']);
  });

  it('records a payment gate by its code, not as an error', async () => {
    const c = await connect();
    const res = await call(c.access_token, 'jaw_pay_and_fetch', { url: 'https://seller.example.test/x' });
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toMatch(/^no_grant: /);

    const events = await eventsOf(await connectionOf(c.access_token));
    expect(events.map((e) => [e.tool, e.outcome])).toEqual([['jaw_pay_and_fetch', 'no_grant']]);
  });

  it('records a quote that found no price as ok, since nothing is paid', async () => {
    const c = await connect();
    const res = await call(c.access_token, 'jaw_quote', { url: 'https://169.254.169.254/latest' });
    expect(res.json.result.structuredContent.refusal.code).toBe('unreachable');

    const events = await eventsOf(await connectionOf(c.access_token));
    expect(events.map((e) => [e.tool, e.outcome])).toEqual([['jaw_quote', 'ok']]);
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
