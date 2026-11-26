/** The few store operations short links need. Every keys instance shares one store, so counts are global. */
export interface Kv {
  /** Stores `value` only if `key` is absent, until `expiresAtMs`. True when it stored. */
  setIfAbsent(key: string, value: string, expiresAtMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** Overwrites a value that exists and keeps its expiry. */
  replace(key: string, value: string): Promise<void>;
  /** Adds one to a counter that disappears `ttlSeconds` after its last use, and returns the new count. */
  count(key: string, ttlSeconds: number): Promise<number>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Reply = { result?: unknown; error?: string };

/**
 * Upstash Redis over its REST API. Errors carry only the status: the store's own message can echo a command, and a
 * command holds a blob.
 */
export function upstashKv(url: string, token: string, fetcher: Fetcher = fetch): Kv {
  async function call(path: string, body: unknown): Promise<unknown> {
    const response = await fetcher(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`kv ${response.status}`);
    return response.json();
  }
  const run = async (command: string[]) => ((await call('', command)) as Reply).result;

  return {
    setIfAbsent: async (key, value, expiresAtMs) =>
      (await run(['SET', key, value, 'NX', 'PXAT', String(expiresAtMs)])) === 'OK',
    get: async (key) => ((await run(['GET', key])) as string | null) ?? null,
    replace: async (key, value) => void (await run(['SET', key, value, 'XX', 'KEEPTTL'])),
    async count(key, ttlSeconds) {
      const replies = (await call('/pipeline', [
        ['INCR', key],
        ['EXPIRE', key, String(ttlSeconds)],
      ])) as Reply[];
      if (replies.some((r) => r.error !== undefined)) throw new Error('kv command failed');
      return Number(replies[0].result);
    },
  };
}

/** The store the Vercel Marketplace integration for Upstash connects through these two variables. */
export function linkKv(): Kv {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN must be set');
  return upstashKv(url, token);
}
