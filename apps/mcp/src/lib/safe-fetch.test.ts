import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { lookup } from 'node:dns';
import { isPrivate, publicOnly, resolvesPublic, safeFetch } from './safe-fetch';

const server = createServer((req, res) => {
  if (req.url === '/redirect') return void res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
  if (req.url === '/large') return void res.writeHead(200, { 'content-length': '1000001' }).end('x'.repeat(1_000_001));
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

  it('given a body one byte over the cap, when it is read, then it is cut at the cap with no content-length', async () => {
    const res = await guarded(`http://127.0.0.1:${port}/large`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBeNull();
    expect((await res.text()).length).toBe(1_000_000);
  });

  it('never follows a redirect', async () => {
    const res = await guarded(`http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(302);
  });
});

describe('isPrivate', () => {
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111'])('lets the public address %s through', (address) => {
    expect(isPrivate(address)).toBe(false);
  });

  it.each(['127.0.0.1', '169.254.169.254', '10.0.0.1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', 'fe80::1'])(
    'refuses %s',
    (address) => {
      expect(isPrivate(address)).toBe(true);
    }
  );
});

describe('given the first address of every range oidc-provider treats as special-use', () => {
  it.each([
    ...['0.0.0.0', '10.0.0.0', '100.64.0.0', '127.0.0.0', '169.254.0.0', '172.16.0.0', '192.0.0.0', '192.0.2.0'],
    ...['192.31.196.0', '192.52.193.0', '192.88.99.0', '192.168.0.0', '192.175.48.0', '198.18.0.0'],
    ...['198.51.100.0', '203.0.113.0', '240.0.0.0', '::', '::1', '64:ff9b::', '64:ff9b:1::', '100::', '100:0:0:1::'],
    ...['2001::', '2001:100::', '2001:db8::', '2002::', '2620:4f:8000::', '3fff::', '5f00::', 'fc00::', 'fd00::'],
    ...['fe80::', 'fe90::', 'fea0::', 'feb0::'],
  ])('then %s is private', (address) => {
    expect(isPrivate(address)).toBe(true);
  });
});

describe('resolvesPublic', () => {
  const answering = (...addresses: string[]) =>
    ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
      )) as unknown as typeof lookup;
  const failing = ((_h: string, _o: unknown, cb: (e: Error) => void) =>
    cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }))) as unknown as typeof lookup;

  it('given a name that resolves to public addresses only, then true', async () => {
    expect(await resolvesPublic('agent.example', answering('93.184.216.34', '2606:4700::1111'))).toBe(true);
  });

  it.each([
    ['a private answer among public ones', 'agent.example', answering('93.184.216.34', '10.0.0.1')],
    ['a bracketed IPv6 literal', '[::1]', answering('::1')],
    ['a name that does not resolve', 'nowhere.example', failing],
  ])('given %s, then false', async (_, host, resolve) => {
    expect(await resolvesPublic(host, resolve)).toBe(false);
  });
});

describe('the connect-time lookup', () => {
  const answers = ['93.184.216.34', '10.0.0.1'];
  const rebinding = ((_host: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: answers.shift() as string, family: 4 }])) as unknown as typeof lookup;
  const connect = publicOnly(rebinding);
  const resolve = () =>
    new Promise<string>((ok, fail) =>
      connect('rebind.example', { family: 0 }, (err, address) => (err ? fail(err) : ok(address as string)))
    );

  it('pins each connection to the address it checked when the answer changes between lookups', async () => {
    await expect(resolve()).resolves.toBe('93.184.216.34');
    await expect(resolve()).rejects.toMatchObject({ name: 'FetchRefused' });
  });

  it('refuses an answer set that mixes a public and a private address', async () => {
    const mixed = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])) as unknown as typeof lookup;
    const refused = new Promise((ok, fail) =>
      publicOnly(mixed)('mixed.example', { family: 0 }, (err) => (err ? fail(err) : ok(undefined)))
    );
    await expect(refused).rejects.toMatchObject({ name: 'FetchRefused' });
  });
});
