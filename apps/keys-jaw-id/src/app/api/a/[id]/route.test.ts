import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kv } from '../../../../lib/link-kv';

const kv = vi.hoisted(() => ({ current: undefined as unknown as Kv }));
vi.mock('../../../../lib/link-kv', async (original) => ({
  ...(await original<object>()),
  linkKv: () => kv.current,
}));

import { DELETE, GET, PUT } from './route';

/** An in-memory store with the semantics the route relies on: create-only, native expiry, counters. */
function memoryKv() {
  const values = new Map<string, { value: string; until: number }>();
  const live = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.until <= Date.now()) values.delete(key);
    return values.get(key);
  };
  const store: Kv & { values: typeof values } = {
    values,
    async setIfAbsent(key, value, expiresAtMs) {
      if (live(key)) return false;
      values.set(key, { value, until: expiresAtMs });
      return true;
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async del(key) {
      values.delete(key);
    },
    async count(key, ttlSeconds) {
      const next = Number(live(key)?.value ?? 0) + 1;
      values.set(key, { value: String(next), until: Date.now() + ttlSeconds * 1000 });
      return next;
    },
  };
  return store;
}

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const OTHER_ID = 'BAQEBAQEBAQEBAQEBAQEBA';
const TOKEN = 'production-token-0000000000000000000000000';
const STAGING_TOKEN = 'staging-token-000000000000000000000000000';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const BLOB = 'A'.repeat(471);
const IN_30_MIN = new Date(NOW + 30 * 60_000).toISOString();

let store: ReturnType<typeof memoryKv>;
let logs: unknown[][];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  store = memoryKv();
  kv.current = store;
  vi.stubEnv('KEYS_LINK_WRITERS', `mcp-production:${hash(TOKEN)},mcp-staging:${hash(STAGING_TOKEN)}`);
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (id: string) => `https://keys.jaw.id/api/a/${id}`;

function put(id: string, body: unknown, { token = TOKEN, raw }: { token?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return PUT(new Request(url(id), { method: 'PUT', headers, body: raw ?? JSON.stringify(body) }), at(id));
}

const get = (id: string, ip = '203.0.113.7') => GET(new Request(url(id), { headers: { 'x-real-ip': ip } }), at(id));

const del = (id: string, token: string | null = TOKEN) =>
  DELETE(
    new Request(url(id), { method: 'DELETE', headers: token === null ? {} : { authorization: `Bearer ${token}` } }),
    at(id)
  );

const body = (blob = BLOB, expiresAt = IN_30_MIN) => ({ blob, expiresAt });

describe('PUT /api/a/[id]', () => {
  it('stores a blob from a listed writer and answers 200', async () => {
    expect((await put(ID, body())).status).toBe(200);
    expect((await (await get(ID)).json()).blob).toBe(BLOB);
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'not-a-writer-token-00000000000000000000000'],
  ])('answers 401 with %s and stores nothing', async (_, token) => {
    expect((await put(ID, body(), { token })).status).toBe(401);
    expect((await get(ID)).status).toBe(404);
  });

  it('answers 401 for a token whose entry was removed', async () => {
    vi.stubEnv('KEYS_LINK_WRITERS', `mcp-staging:${hash(STAGING_TOKEN)}`);
    expect((await put(ID, body())).status).toBe(401);
  });

  it('accepts both entries during a rotation', async () => {
    expect((await put(ID, body())).status).toBe(200);
    expect((await put(OTHER_ID, body(), { token: STAGING_TOKEN })).status).toBe(200);
  });

  it('answers 401 when no writer is configured', async () => {
    vi.stubEnv('KEYS_LINK_WRITERS', '');
    expect((await put(ID, body())).status).toBe(401);
  });

  it('answers 200 again for the same body, so a retry after a timeout is safe', async () => {
    await put(ID, body());
    expect((await put(ID, body())).status).toBe(200);
  });

  it('answers 409 for a different body and keeps the stored blob', async () => {
    await put(ID, body());
    expect((await put(ID, body('B'.repeat(471)))).status).toBe(409);
    expect((await put(ID, body(BLOB, new Date(NOW + 20 * 60_000).toISOString()))).status).toBe(409);
    expect((await (await get(ID)).json()).blob).toBe(BLOB);
  });

  it('answers 413 for a blob over 1 KiB', async () => {
    expect((await put(ID, body('A'.repeat(1025)))).status).toBe(413);
    expect((await put(ID, body('A'.repeat(1024)))).status).toBe(200);
  });

  it('answers 413 for a request body over 2 KiB, whatever it holds', async () => {
    expect((await put(ID, null, { raw: JSON.stringify({ ...body(), pad: 'x'.repeat(2048) }) })).status).toBe(413);
  });

  it.each([
    ['an id that is too short', 'AQEBAQEBAQEBAQEBAQEBA', body()],
    ['an id with a bad character', 'AQEBAQEBAQEBAQEBAQEB.Q', body()],
    ['a past expiresAt', ID, body(BLOB, new Date(NOW - 1000).toISOString())],
    ['an expiresAt more than 60 minutes ahead', ID, body(BLOB, new Date(NOW + 60 * 60_000 + 1).toISOString())],
    ['an expiresAt that is not a date', ID, body(BLOB, 'soon')],
    ['an expiresAt that is not ISO 8601', ID, body(BLOB, String(NOW + 60_000))],
    ['a blob that is not base64url', ID, body('not base64url!')],
    ['an empty blob', ID, body('')],
    ['a body without a blob', ID, { expiresAt: IN_30_MIN }],
  ])('answers 422 for %s', async (_, id, payload) => {
    expect((await put(id, payload)).status).toBe(422);
  });

  it('answers 422 for a body that is not JSON', async () => {
    expect((await put(ID, null, { raw: '{nope' })).status).toBe(422);
  });

  it('answers 422 for an expiresAt of right now', async () => {
    expect((await put(ID, body(BLOB, new Date(NOW).toISOString()))).status).toBe(422);
  });

  it('accepts a request body of exactly 2 KiB', async () => {
    const json = JSON.stringify(body());
    const raw = `${json.slice(0, -1)}${' '.repeat(2048 - json.length)}}`;
    expect(raw).toHaveLength(2048);
    expect((await put(ID, null, { raw })).status).toBe(200);
    expect((await put(OTHER_ID, null, { raw: `${raw} ` })).status).toBe(413);
  });

  it.each([
    ['a token after something else', `x Bearer ${TOKEN}`],
    ['a token followed by more', `Bearer ${TOKEN} more`],
    ['another scheme', `Basic ${TOKEN}`],
  ])('answers 401 for %s', async (_, authorization) => {
    const request = new Request(url(ID), { method: 'PUT', headers: { authorization }, body: JSON.stringify(body()) });
    expect((await PUT(request, at(ID))).status).toBe(401);
  });

  it.each([
    ['an entry with no label', `:${hash(TOKEN)}`],
    ['an entry whose hash is not lowercase hex', `mcp-production:${hash(TOKEN).toUpperCase()}`],
    ['an entry with a prefix before its hash', `mcp-production:00${hash(TOKEN)}`],
    ['an entry with a suffix after its hash', `mcp-production:${hash(TOKEN)}00`],
  ])('ignores %s', async (_, entry) => {
    vi.stubEnv('KEYS_LINK_WRITERS', entry);
    expect((await put(ID, body())).status).toBe(401);
  });

  it('accepts an entry with spaces around it', async () => {
    vi.stubEnv('KEYS_LINK_WRITERS', ` mcp-production:${hash(TOKEN)} `);
    expect((await put(ID, body())).status).toBe(200);
  });

  it('accepts an expiresAt exactly 60 minutes ahead', async () => {
    expect((await put(ID, body(BLOB, new Date(NOW + 60 * 60_000).toISOString()))).status).toBe(200);
  });

  it('answers 429 on the 301st write in a minute for one writer, and leaves another writer alone', async () => {
    for (let i = 0; i < 300; i++) expect((await put(ID, body())).status).toBe(200);
    expect((await put(ID, body())).status).toBe(429);
    expect((await put(OTHER_ID, body(), { token: STAGING_TOKEN })).status).toBe(200);
  });

  it('gives a writer a new minute budget in the next minute', async () => {
    for (let i = 0; i < 301; i++) await put(ID, body());
    vi.setSystemTime(NOW + 60_000);
    expect((await put(ID, body())).status).toBe(200);
  });

  it('counts deletes against the same budget as writes', async () => {
    for (let i = 0; i < 300; i++) await del(ID);
    expect((await put(ID, body())).status).toBe(429);
  });

  it('answers 429 past 5000 writes in an hour, across minutes', async () => {
    for (let minute = 0; minute < 17; minute++) {
      vi.setSystemTime(NOW + minute * 60_000);
      for (let i = 0; i < 300 && minute * 300 + i < 5000; i++) {
        expect((await put(ID, body(BLOB, new Date(NOW + 59 * 60_000).toISOString()))).status).toBe(200);
      }
    }
    vi.setSystemTime(NOW + 17 * 60_000);
    expect((await put(ID, body(BLOB, new Date(NOW + 59 * 60_000).toISOString()))).status).toBe(429);
  });

  it('answers 503 when the store fails, and logs no body or token', async () => {
    kv.current = { ...store, setIfAbsent: () => Promise.reject(new Error('kv 500')) };
    expect((await put(ID, body())).status).toBe(503);
    expect(JSON.stringify(logs)).not.toContain(BLOB);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});

describe('GET /api/a/[id]', () => {
  it('returns only the blob, with no-store and no-referrer', async () => {
    await put(ID, body());
    const response = await get(ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blob: BLOB });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('answers 404 for a missing entry and a bad id', async () => {
    expect((await get(ID)).status).toBe(404);
    expect((await get('nope')).status).toBe(404);
  });

  it('answers 404 after expiresAt even while the store still holds the key', async () => {
    await put(ID, body());
    const stored = store.values.get(`link:${ID}`);
    store.values.set(`link:${ID}`, { value: String(stored?.value), until: Number.POSITIVE_INFINITY });
    vi.setSystemTime(NOW + 30 * 60_000);
    expect((await get(ID)).status).toBe(404);
  });

  it('answers 404 after DELETE', async () => {
    await put(ID, body());
    expect((await del(ID)).status).toBe(204);
    expect((await get(ID)).status).toBe(404);
  });

  it('answers 429 on the 61st read in a minute from one address, and leaves another address alone', async () => {
    await put(ID, body());
    // The clock moves within the minute, so the window is the minute and not the instant.
    for (let i = 0; i < 60; i++) {
      vi.setSystemTime(NOW + i * 500);
      expect((await get(ID)).status).toBe(200);
    }
    expect((await get(ID)).status).toBe(429);
    expect((await get(ID, '198.51.100.9')).status).toBe(200);
  });

  it('gives an address a new read budget in the next minute', async () => {
    await put(ID, body());
    for (let i = 0; i < 61; i++) await get(ID);
    vi.setSystemTime(NOW + 60_000);
    expect((await get(ID)).status).toBe(200);
  });

  it('takes the address from x-forwarded-for when x-real-ip is absent', async () => {
    await put(ID, body());
    const fromProxy = (ip: string) =>
      GET(new Request(url(ID), { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } }), at(ID));
    for (let i = 0; i < 60; i++) await fromProxy('203.0.113.7');
    expect((await fromProxy('203.0.113.7')).status).toBe(429);
    expect((await fromProxy('198.51.100.9')).status).toBe(200);
  });

  it('answers 503 when the store fails', async () => {
    kv.current = { ...store, count: () => Promise.reject(new Error('kv 500')) };
    expect((await get(ID)).status).toBe(503);
  });
});

describe('DELETE /api/a/[id]', () => {
  it('answers 429 once the writer is over its budget, and keeps the blob', async () => {
    await put(ID, body());
    for (let i = 0; i < 299; i++) await del(OTHER_ID);
    expect((await del(ID)).status).toBe(429);
    expect((await get(ID)).status).toBe(200);
  });

  it('answers 401 without a listed writer and keeps the blob', async () => {
    await put(ID, body());
    expect((await del(ID, null)).status).toBe(401);
    expect((await del(ID, 'not-a-writer-token-00000000000000000000000')).status).toBe(401);
    expect((await get(ID)).status).toBe(200);
  });

  it('answers 204 for an id that is not there', async () => {
    expect((await del(ID)).status).toBe(204);
  });
});

describe('what the routes log', () => {
  it('names the method, status and writer, never the body, the token or the Authorization header', async () => {
    await put(ID, body());
    await put(ID, body('B'.repeat(471)));
    await put(ID, body(), { token: 'not-a-writer-token-00000000000000000000000' });
    await get(ID);
    await del(ID);

    const text = JSON.stringify(logs);
    expect(text).not.toContain(BLOB);
    expect(text).not.toContain('B'.repeat(471));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('not-a-writer-token');
    expect(text.toLowerCase()).not.toContain('bearer');
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(logs.map(([line]) => JSON.parse(String(line)))).toEqual([
      { msg: 'short link', method: 'PUT', status: 200, writer: 'mcp-production' },
      { msg: 'short link', method: 'PUT', status: 409, writer: 'mcp-production' },
      { msg: 'short link', method: 'PUT', status: 401, writer: null },
      { msg: 'short link', method: 'DELETE', status: 204, writer: 'mcp-production' },
    ]);
  });
});
