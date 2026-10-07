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
});
