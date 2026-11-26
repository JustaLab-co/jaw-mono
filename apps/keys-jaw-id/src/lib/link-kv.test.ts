import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkKv, upstashKv } from './link-kv';

const URL_ = 'https://kv.example.upstash.io';

function answering(...results: unknown[]) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(results.shift())));
}

const sent = (fetcher: ReturnType<typeof answering>, call = 0) => {
  const [url, init] = fetcher.mock.calls[call];
  return { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
};

afterEach(() => vi.unstubAllEnvs());

describe('upstashKv', () => {
  it('creates with SET NX PXAT and reports whether it set', async () => {
    const fetcher = answering({ result: 'OK' }, { result: null });
    const kv = upstashKv(URL_, 'tok', fetcher);

    expect(await kv.setIfAbsent('link:a', 'v', 1_700_000_000_000)).toBe(true);
    expect(await kv.setIfAbsent('link:a', 'v', 1_700_000_000_000)).toBe(false);
    expect(sent(fetcher)).toEqual({
      url: URL_,
      body: ['SET', 'link:a', 'v', 'NX', 'PXAT', '1700000000000'],
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', cache: 'no-store' });
  });

  it('reads, and replaces keeping the expiry', async () => {
    const fetcher = answering({ result: 'v' }, { result: null }, { result: 1 });
    const kv = upstashKv(URL_, 'tok', fetcher);

    expect(await kv.get('link:a')).toBe('v');
    expect(await kv.get('link:b')).toBeNull();
    await kv.replace('link:a', 'w');
    expect(sent(fetcher, 0).body).toEqual(['GET', 'link:a']);
    expect(sent(fetcher, 2).body).toEqual(['SET', 'link:a', 'w', 'XX', 'KEEPTTL']);
  });

  it('counts with INCR and EXPIRE in one pipeline', async () => {
    const fetcher = answering([{ result: 3 }, { result: 1 }]);

    expect(await upstashKv(URL_, 'tok', fetcher).count('rl:x', 120)).toBe(3);
    expect(sent(fetcher)).toMatchObject({
      url: `${URL_}/pipeline`,
      body: [
        ['INCR', 'rl:x'],
        ['EXPIRE', 'rl:x', '120'],
      ],
    });
  });

  it('throws on an error answer, naming only the status', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: 'WRONGPASS secret detail' }), { status: 401 })
    );

    await expect(upstashKv(URL_, 'tok', fetcher).get('link:a')).rejects.toThrow(/^kv 401$/);
  });

  it('throws on a pipeline command that failed', async () => {
    const fetcher = answering([{ result: 1 }, { error: 'ERR' }]);

    await expect(upstashKv(URL_, 'tok', fetcher).count('rl:x', 120)).rejects.toThrow('kv command failed');
  });
});

describe('linkKv', () => {
  it.each([
    ['nothing', '', ''],
    ['only the URL', URL_, ''],
    ['only the token', '', 'tok'],
  ])('throws when the store is configured with %s', (_, url, token) => {
    vi.stubEnv('KV_REST_API_URL', url);
    vi.stubEnv('KV_REST_API_TOKEN', token);
    expect(() => linkKv()).toThrow('KV_REST_API_URL and KV_REST_API_TOKEN must be set');
  });

  it('builds a client from the environment', () => {
    vi.stubEnv('KV_REST_API_URL', URL_);
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    expect(linkKv()).toHaveProperty('setIfAbsent');
  });
});
