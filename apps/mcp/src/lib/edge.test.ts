import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ paused: false, down: false, hits: new Map<string, number>() }));
vi.mock('@/db/settings', () => ({
  isPaused: async () => {
    if (store.down)
      throw new Error('Failed query', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    return store.paused;
  },
  countHit: async (key: string) => {
    store.hits.set(key, (store.hits.get(key) ?? 0) + 1);
    return store.hits.get(key);
  },
}));
vi.mock('./cors', () => ({
  pageCors: (res: Response) => {
    res.headers.set('access-control-allow-origin', 'http://keys.test');
    return res;
  },
}));

const { withEdge, RATE_LIMIT } = await import('./edge');

const ok = async () => Response.json({ ok: true });
const ctx = { params: Promise.resolve({}) };
// The proxy appends the address it saw; whatever the caller sent comes first.
const req = (ip = '203.0.113.7', url = 'http://mcp.test/api/approvals/q3L0x7mJ2c1VfN8aYw4p9A?code=secret') =>
  new Request(url, {
    method: 'POST',
    headers: { 'x-forwarded-for': `1.2.3.${Math.floor(Math.random() * 255)}, ${ip}` },
  });
const call = (handler: ReturnType<typeof withEdge>, r = req()) => handler(r, ctx);

let lines: string[];
beforeEach(() => {
  store.paused = false;
  store.down = false;
  store.hits.clear();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
});
afterEach(() => vi.restoreAllMocks());

describe('withEdge', () => {
  it('stamps a request id and logs one line with neither the query string nor path ids', async () => {
    const res = await call(withEdge(ok, { guarded: true }));
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      requestId: id,
      method: 'POST',
      path: '/api/approvals/:id',
      status: 200,
    });
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('q3L0x7mJ2c1VfN8aYw4p9A');
  });

  it('by default ignores x-forwarded-for and keys on the platform header x-real-ip', async () => {
    delete process.env.JAW_MCP_TRUSTED_PROXY_HOPS;
    const handler = withEdge(ok, { guarded: true });
    const as = (realIp: string, forwarded: string) =>
      new Request('http://mcp.test/mcp', { headers: { 'x-real-ip': realIp, 'x-forwarded-for': forwarded } });
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await handler(as('203.0.113.7', `10.0.0.${i}`), ctx)).status).toBe(200);
    expect((await handler(as('203.0.113.7', '10.9.9.9'), ctx)).status).toBe(429);
    expect((await handler(as('198.51.100.1', '10.9.9.9'), ctx)).status).toBe(200);
  });

  it('with N trusted proxy hops keys on the Nth entry from the right', async () => {
    process.env.JAW_MCP_TRUSTED_PROXY_HOPS = '2';
    const handler = withEdge(ok, { guarded: true });
    // client-chosen junk, then the client as the first trusted proxy saw it, then that proxy
    const via = (junk: string, client: string) =>
      new Request('http://mcp.test/mcp', { headers: { 'x-forwarded-for': `${junk}, ${client}, 10.0.0.1` } });
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await handler(via(`1.2.3.${i}`, '203.0.113.7'), ctx)).status).toBe(200);
    expect((await handler(via('9.9.9.9', '203.0.113.7'), ctx)).status).toBe(429);
    expect((await handler(via('9.9.9.9', '198.51.100.1'), ctx)).status).toBe(200);
    delete process.env.JAW_MCP_TRUSTED_PROXY_HOPS;
  });

  it('answers 503 while the kill switch is on, without calling the route', async () => {
    store.paused = true;
    const route = vi.fn(ok);
    const res = await call(withEdge(route, { guarded: true }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'paused' });
    expect(route).not.toHaveBeenCalled();
  });

  it('puts CORS headers on refusals too, so the page can read them', async () => {
    store.paused = true;
    const res = await call(withEdge(ok, { guarded: true, cors: true }));
    expect(res.headers.get('access-control-allow-origin')).toBe('http://keys.test');
  });

  it('answers 503 when the database is unreachable, from the guard or the route', async () => {
    store.down = true;
    expect((await call(withEdge(ok, { guarded: true }))).status).toBe(503);
    store.down = false;
    const dbDown = async () => {
      throw new Error('Failed query', { cause: { code: 'CONNECT_TIMEOUT' } });
    };
    expect((await call(withEdge(dbDown, { guarded: false }))).status).toBe(503);
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN'])('answers 503 when the database host does not resolve (%s)', async (code) => {
    const lookupFailed = async () => {
      throw new Error('Failed query', { cause: { code } });
    };
    expect((await call(withEdge(lookupFailed, { guarded: false }))).status).toBe(503);
  });

  it('leaves unguarded routes open while paused', async () => {
    store.paused = true;
    expect((await call(withEdge(ok, { guarded: false }))).status).toBe(200);
  });

  it('logs only the error class and driver code, never the message', async () => {
    const res = await call(
      withEdge(
        async () => {
          throw new Error('Failed query: insert ... params: v1.sealed,token', { cause: { code: '23505' } });
        },
        { guarded: false }
      )
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', requestId: res.headers.get('x-request-id') });
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', error: 'Error 23505' });
    expect(lines.join('\n')).not.toContain('sealed');
  });
});
