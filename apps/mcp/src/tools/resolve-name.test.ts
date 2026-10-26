import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getAddress } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { safeFetch } from '@/lib/safe-fetch';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { leaks, spoken } from '@/test-utils/spoken';
import { lookup, type ResolveDeps } from './resolve-name';

const KEY = 'resolve-secret-key';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BASE_ADDR = getAddress('0x00000000000000000000000000000000000000b5');

type Backend = { status: number; body: unknown; stall: boolean };
let backend: Backend;
const seen: { url: string; key: string | string[] | undefined }[] = [];

const envelope = (data: unknown) => ({ statusCode: 200, result: { data, error: null } });
const records = (addresses: { id: number; name: string; value: string }[]) =>
  envelope({ ens: 'vitalik.eth', records: { addresses } });

const server = createServer((req, res) => {
  seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] });
  if (backend.stall) return;
  res.writeHead(backend.status, { 'content-type': 'application/json' }).end(JSON.stringify(backend.body));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
afterAll(() => void server.close());

const HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
setTestEnv();
process.env.JAW_MCP_INSECURE_FETCH_HOSTS = HOST;
process.env.JAW_MCP_RESOLVE_URL = `http://${HOST}/ens/v2`;
process.env.JAW_MCP_RESOLVE_API_KEY = KEY;

const deps = (timeoutMs = 2_000): ResolveDeps => ({
  fetch: safeFetch(new Set([HOST])),
  url: `http://${HOST}/ens/v2`,
  apiKey: KEY,
  timeoutMs,
});

beforeEach(() => {
  seen.length = 0;
  backend = { status: 200, body: records([]), stall: false };
});

describe('lookup of a name', () => {
  it('given a name with addresses on several chains, returns each with its chain and the mainnet one as address', async () => {
    backend.body = records([
      { id: 60, name: 'eth', value: VITALIK },
      { id: 0x80000000 + 8453, name: 'base', value: BASE_ADDR },
    ]);
    const r = await lookup({ name: 'vitalik.eth' }, deps());
    expect(r).toMatchObject({ name: 'vitalik.eth', address: VITALIK, chainId: 'eip155:1' });
    expect(r.addresses).toEqual([
      { coinType: 60, chainId: 'eip155:1', address: VITALIK },
      { coinType: 0x80000000 + 8453, chainId: 'eip155:8453', address: BASE_ADDR },
    ]);
    expect(r.reason).toBeUndefined();
  });

  it('given a name with no mainnet address, keeps the others and returns no address', async () => {
    backend.body = records([{ id: 0x80000000 + 8453, name: 'base', value: BASE_ADDR }]);
    const r = await lookup({ name: 'vitalik.eth' }, deps());
    expect(r).toMatchObject({ address: null });
    expect(r.addresses).toHaveLength(1);
  });

  it('given a name in capitals, asks for the normalized form', async () => {
    backend.body = records([{ id: 60, name: 'eth', value: VITALIK }]);
    await lookup({ name: 'VITALIK.eth' }, deps());
    expect(new URL(seen[0].url, 'http://x').searchParams.get('ens')).toBe('vitalik.eth');
  });

  it('given a name with no records, answers no_address and keeps the name', async () => {
    expect(await lookup({ name: 'nobody.eth' }, deps())).toMatchObject({
      name: 'nobody.eth',
      address: null,
      addresses: [],
      reason: 'no_address',
    });
  });

  it('given a domain the resolver has not onboarded (404), answers no_address', async () => {
    backend.status = 404;
    expect(await lookup({ name: 'nobody.eth' }, deps())).toMatchObject({ reason: 'no_address' });
  });

  it('given a name that does not parse, answers invalid_name without asking the backend', async () => {
    expect(await lookup({ name: 'a\u0000.eth' }, deps())).toMatchObject({ reason: 'invalid_name', address: null });
    expect(seen).toHaveLength(0);
  });
});

describe('lookup of a name with unusual records', () => {
  it('given bitcoin and solana records as raw bytes, drops them', async () => {
    backend.body = records([
      { id: 60, name: 'eth', value: VITALIK },
      { id: 0, name: 'btc', value: '0x00149b97c1d2a3b4c5d6e7f8091a2b3c4d5e6f708192' },
      { id: 501, name: 'sol', value: '0xf0218283a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2' },
    ]);
    const r = await lookup({ name: 'luc.eth' }, deps());
    expect(r.addresses).toEqual([{ coinType: 60, chainId: 'eip155:1', address: VITALIK }]);
    expect(r.summary).not.toContain('501');
  });

  it('given the ENSIP-19 default EVM record, marks it as default and checksums it', async () => {
    backend.body = records([
      { id: 60, name: 'eth', value: VITALIK },
      { id: 0x80000000, name: 'default', value: BASE_ADDR.toLowerCase() },
    ]);
    const r = await lookup({ name: 'brantly.eth' }, deps());
    expect(r.addresses[1]).toEqual({ coinType: 0x80000000, default: true, address: BASE_ADDR });
    expect(r.summary).toContain('any other EVM chain');
  });

  it('given a chain address in lowercase, returns it checksummed', async () => {
    backend.body = records([{ id: 0x80000000 + 10, name: 'op', value: VITALIK.toLowerCase() }]);
    const r = await lookup({ name: 'vitalik.eth' }, deps());
    expect(r.addresses).toEqual([{ coinType: 0x80000000 + 10, chainId: 'eip155:10', address: VITALIK }]);
  });
});

describe('lookup of an address', () => {
  it('given an address with a primary name, returns the name', async () => {
    backend.body = envelope({ address: VITALIK.toLowerCase(), name: 'vitalik.eth', coinType: 60 });
    const r = await lookup({ address: VITALIK.toLowerCase() }, deps());
    expect(r).toMatchObject({ name: 'vitalik.eth', address: VITALIK, chainId: 'eip155:1' });
    const query = new URL(seen[0].url, 'http://x');
    expect(query.pathname).toBe('/ens/v2/reverse');
    expect(query.searchParams.get('coinType')).toBe('60');
  });

  it('given an address with no primary name, answers no_primary_name', async () => {
    backend.body = envelope({ address: VITALIK, name: null, coinType: 60 });
    expect(await lookup({ address: VITALIK }, deps())).toMatchObject({ name: null, reason: 'no_primary_name' });
  });

  it('given a string that is no address, answers invalid_address without asking the backend', async () => {
    expect(await lookup({ address: '0x1234' }, deps())).toMatchObject({ reason: 'invalid_address' });
    expect(seen).toHaveLength(0);
  });
});

describe('a backend that fails', () => {
  it('sends the key as x-api-key on both lookups', async () => {
    await lookup({ name: 'vitalik.eth' }, deps());
    await lookup({ address: VITALIK }, deps());
    expect(seen.map((s) => s.key)).toEqual([KEY, KEY]);
  });

  it.each([402, 401, 403, 400, 500, 503])('given a %i, answers lookup_failed without the key', async (status) => {
    backend.status = status;
    backend.body = { error: `bad key ${KEY}` };
    const r = await lookup({ name: 'vitalik.eth' }, deps());
    expect(r).toMatchObject({ reason: 'lookup_failed', address: null });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('given a body that is not the backend envelope, answers lookup_failed', async () => {
    backend.body = { hello: 'world' };
    expect(await lookup({ name: 'vitalik.eth' }, deps())).toMatchObject({ reason: 'lookup_failed' });
    expect(await lookup({ address: VITALIK }, deps())).toMatchObject({ reason: 'lookup_failed' });
  });

  it('given a backend that never answers, answers lookup_failed at the deadline', async () => {
    backend.stall = true;
    const started = Date.now();
    const r = await lookup({ name: 'vitalik.eth' }, deps(200));
    expect(r).toMatchObject({ reason: 'lookup_failed' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('jaw_resolve_name', () => {
  let token: string;
  beforeAll(async () => {
    await useTestDb();
    token = (await connect(undefined, { scope: 'wallet:read' })).access_token;
  });

  it('given only wallet:read, answers every chain of a name', async () => {
    backend.body = records([
      { id: 60, name: 'eth', value: VITALIK },
      { id: 0x80000000 + 8453, name: 'base', value: BASE_ADDR },
    ]);
    const r = await callTool(token, 'jaw_resolve_name', { name: 'vitalik.eth' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ address: VITALIK });
    expect(r.structuredContent.addresses).toHaveLength(2);
    expect(seen[0].key).toBe(KEY);
  });

  it('given a bad name, refuses with its reason', async () => {
    const r = await callTool(token, 'jaw_resolve_name', { name: 'a\u0000.eth' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ reason: 'invalid_name' });
  });

  it('given both a name and an address, or neither, refuses', async () => {
    for (const args of [{ name: 'vitalik.eth', address: VITALIK }, {}]) {
      const r = await callTool(token, 'jaw_resolve_name', args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('exactly one');
    }
  });

  it('given a backend that refuses the key, answers lookup_failed as an error', async () => {
    backend.status = 402;
    const r = await callTool(token, 'jaw_resolve_name', { name: 'vitalik.eth' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ reason: 'lookup_failed' });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe('The lookup could not finish right now. Try again.');
  });

  it('given both a name and an address, then the owner hears that nothing was looked up, and the agent how to ask', async () => {
    const r = await callTool(token, 'jaw_resolve_name', { name: 'vitalik.eth', address: VITALIK });
    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe('Nothing was looked up.');
  });
});
