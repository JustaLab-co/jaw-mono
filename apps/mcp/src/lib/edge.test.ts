import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ paused: false, hits: new Map<string, number>() }));
vi.mock('@/db/settings', () => ({
  isPaused: async () => store.paused,
  countHit: async (key: string) => {
    store.hits.set(key, (store.hits.get(key) ?? 0) + 1);
    return store.hits.get(key);
  },
}));

const { withEdge, RATE_LIMIT } = await import('./edge');

const ok = async () => Response.json({ ok: true });
const req = (ip = '203.0.113.7', url = 'http://mcp.test/mcp?code=secret') =>
  new Request(url, { method: 'POST', headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });

let lines: string[];
beforeEach(() => {
  store.paused = false;
  store.hits.clear();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
});
afterEach(() => vi.restoreAllMocks());

describe('withEdge', () => {
  it('stamps a request id and logs one line without the query string', async () => {
    const res = await withEdge(ok, { guarded: true })(req());
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ requestId: id, method: 'POST', path: '/mcp', status: 200 });
    expect(lines[0]).not.toContain('secret');
  });

  it('answers 429 once an IP passes the limit, and counts other IPs apart', async () => {
    const handler = withEdge(ok, { guarded: true });
    for (let i = 0; i < RATE_LIMIT; i++) expect((await handler(req())).status).toBe(200);
    const limited = await handler(req());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await handler(req('198.51.100.1'))).status).toBe(200);
  });

  it('answers 503 while the kill switch is on, without calling the route', async () => {
    store.paused = true;
    const route = vi.fn(ok);
    const res = await withEdge(route, { guarded: true })(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paused' });
    expect(route).not.toHaveBeenCalled();
  });

  it('leaves unguarded routes open while paused', async () => {
    store.paused = true;
    expect((await withEdge(ok, { guarded: false })(req())).status).toBe(200);
  });

  it('turns a thrown error into a 500 that carries the request id and not the message', async () => {
    const res = await withEdge(
      async () => {
        throw new Error('token abc leaked');
      },
      { guarded: false }
    )(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error', requestId: res.headers.get('x-request-id') });
  });
});
