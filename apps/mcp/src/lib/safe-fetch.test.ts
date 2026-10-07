import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { safeFetch } from './safe-fetch';

const server = createServer((req, res) => {
  if (req.url === '/redirect') return void res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
  res.writeHead(402, { 'payment-required': 'abc' }).end('body');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
afterAll(() => void server.close());

describe('safeFetch', () => {
  const guarded = safeFetch(new Set([`127.0.0.1:${port}`]));

  it.each([
    'http://example.com/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[fd00::1]/x',
    'https://[64:ff9b::a9fe:a9fe]/x',
    'https://198.18.0.1/x',
  ])('refuses %s', async (url) => {
    await expect(guarded(url)).rejects.toMatchObject({ name: 'FetchRefused' });
  });

  it('refuses a name that resolves to a private address, at connect time', async () => {
    await expect(guarded(`https://localhost:${port}/x`)).rejects.toMatchObject({ name: 'FetchRefused' });
  });

  it('reads status, headers and body from an allowed host', async () => {
    const res = await guarded(`http://127.0.0.1:${port}/exact`);
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBe('abc');
    expect(await res.text()).toBe('body');
  });

  it('never follows a redirect', async () => {
    const res = await guarded(`http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(302);
  });
});
