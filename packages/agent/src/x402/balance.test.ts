import { afterEach, describe, it, expect, vi } from 'vitest';
import { chainClients, usdcBalance } from './balance.js';

const OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

describe('usdcBalance', () => {
  it('formats a balance for a supported network', async () => {
    const result = await usdcBalance('eip155:84532', OWNER, async () => 1_500_000n);
    expect(result).toEqual({
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      raw: '1500000',
      formatted: '1.5',
    });
  });

  it('reports a zero balance', async () => {
    const result = await usdcBalance('eip155:8453', OWNER, async () => 0n);
    expect(result.raw).toBe('0');
    expect(result.formatted).toBe('0');
  });

  it('throws on an unsupported network', async () => {
    await expect(usdcBalance('eip155:1', OWNER, async () => 0n)).rejects.toThrow(/Unsupported x402 network/);
  });
});

describe('chainClients', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the api key in a header and keeps it out of the url and its errors', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') });
      return new Response('denied', { status: 403 });
    });

    const failure = await chainClients('key-under-test')
      .publicClient(84532)
      .getBlockNumber()
      .catch((err: Error) => err);

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.url).toBe('https://api.justaname.id/proxy/v1/rpc?chainId=84532');
      expect(request.key).toBe('key-under-test');
    }
    expect(String(failure)).not.toContain('key-under-test');
  });

  it('does not follow a redirect, which would carry the key to another origin', async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' });
    });

    await chainClients('key-under-test').publicClient(84532).getBlockNumber();

    expect(redirects).toEqual(['error']);
  });

  it.each(['abc\nsecret', 'clave-\u00f1-secret', 'sk_live_SECRET\u0000', 'key-\u{1F511}-secret'])(
    'refuses %j without sending it or naming it',
    async (key) => {
      const sent = vi.fn();
      // `new Headers` is where undici refuses a value, with the value in its message.
      vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
        new Headers(init?.headers);
        sent();
        return new Response('denied', { status: 403 });
      });

      const failure = await Promise.resolve()
        .then(() => chainClients(key).publicClient(84532).getBlockNumber())
        .catch((err: Error) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('api key');
      expect(String(failure)).not.toContain('secret');
      expect(sent).not.toHaveBeenCalled();
    }
  );
});
