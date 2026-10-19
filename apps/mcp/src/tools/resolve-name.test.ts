import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { custom, encodeErrorResult, offchainLookupAbiItem } from 'viem';
import { ccipRequest, ensClient, lookup, type EnsClient } from './resolve-name';

const mainnetNode = { stall: false, requests: 0, closed: [] as Promise<void>[] };
const rpc = createServer((req) => {
  mainnetNode.requests++;
  mainnetNode.closed.push(new Promise((done) => req.socket.on('close', () => done())));
  if (!mainnetNode.stall) req.socket.destroy();
});
await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', r));
afterAll(() => void rpc.close());

setTestEnv();
process.env.JAW_MCP_MAINNET_RPC_URL = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER = '0x0000000000000000000000000000000000000001';

const records = {
  forward: { 'vitalik.eth': VITALIK } as Record<string, string>,
  reverse: { [VITALIK]: 'vitalik.eth', [OTHER]: 'someone-else.eth' } as Record<string, string>,
};

const client: EnsClient = {
  getEnsAddress: async ({ name }) => (records.forward[name] as `0x${string}` | undefined) ?? null,
  getEnsName: async ({ address }) => records.reverse[address] ?? null,
};

const down: EnsClient = {
  getEnsAddress: async () => {
    throw new Error('gateway unreachable');
  },
  getEnsName: async () => {
    throw new Error('gateway unreachable');
  },
};

describe('lookup', () => {
  it('given a name with an address, returns it', async () => {
    expect(await lookup({ name: 'vitalik.eth' }, () => client)).toMatchObject({
      name: 'vitalik.eth',
      address: VITALIK,
      chainId: 'eip155:1',
    });
  });

  it('given a name in capitals, looks up the normalized form', async () => {
    expect(await lookup({ name: 'VITALIK.eth' }, () => client)).toMatchObject({
      name: 'vitalik.eth',
      address: VITALIK,
    });
  });

  it('given an address with a primary name that points back, returns the name', async () => {
    expect(await lookup({ address: VITALIK.toLowerCase() }, () => client)).toMatchObject({
      name: 'vitalik.eth',
      address: VITALIK,
    });
  });

  it('given a name that does not parse, answers invalid_name', async () => {
    expect(await lookup({ name: 'a\u0000.eth' }, () => client)).toMatchObject({
      reason: 'invalid_name',
      address: null,
    });
  });

  it('given a name with no record, answers no_address and keeps the name', async () => {
    expect(await lookup({ name: 'nobody.eth' }, () => client)).toMatchObject({
      name: 'nobody.eth',
      address: null,
      reason: 'no_address',
    });
  });

  it('given a string that is no address, answers invalid_address', async () => {
    expect(await lookup({ address: '0x1234' }, () => client)).toMatchObject({ reason: 'invalid_address' });
  });

  it('given an address with no primary name, answers no_primary_name', async () => {
    expect(await lookup({ address: '0x0000000000000000000000000000000000000002' }, () => client)).toMatchObject({
      name: null,
      reason: 'no_primary_name',
    });
  });

  it('given a primary name that does not resolve back, does not return it', async () => {
    const r = await lookup({ address: OTHER }, () => client);
    expect(r).toMatchObject({ name: null, reason: 'unverified_name' });
  });

  it('given a lookup that fails, answers lookup_failed without the error text', async () => {
    const r = await lookup({ name: 'vitalik.eth' }, () => down);
    expect(r).toMatchObject({ reason: 'lookup_failed' });
    expect(JSON.stringify(r)).not.toContain('gateway');
  });
});

describe('ccip-read gateways', () => {
  const lookupArgs = { data: '0x1234', sender: OTHER } as const;

  it.each([
    ['https://127.0.0.1/{sender}/{data}.json', 'the URL resolves to a private address'],
    ['https://169.254.169.254/gateway', 'the URL resolves to a private address'],
    ['https://[::1]/gateway', 'the URL resolves to a private address'],
    ['http://example.com/gateway', 'only https URLs can be fetched'],
  ])('given a resolver that points the gateway at %s, refuses before connecting', async (url, message) => {
    await expect(ccipRequest({ ...lookupArgs, urls: [url] })).rejects.toMatchObject({ name: 'FetchRefused', message });
  });

  it('given a lookup whose deadline has passed, stops before asking a gateway', async () => {
    const resolver = custom({
      request: async ({ params }) => {
        const to = (params as [{ to: `0x${string}` }])[0].to;
        const data = encodeErrorResult({
          abi: [offchainLookupAbiItem],
          errorName: 'OffchainLookup',
          args: [to, ['http://example.com/{data}'], '0x1234', '0x12345678', '0x'],
        });
        throw Object.assign(new Error('execution reverted'), { code: 3, data });
      },
    });
    const late = ensClient(resolver, AbortSignal.abort());
    await expect(late.getEnsAddress({ name: 'vitalik.eth' })).rejects.toMatchObject({ cause: { name: 'AbortError' } });
  });
});

describe('the lookup deadline', () => {
  it('given a node that never answers, answers lookup_failed at the deadline and drops the request', async () => {
    mainnetNode.stall = true;
    const before = mainnetNode.requests;
    const started = Date.now();
    const r = await lookup({ name: 'vitalik.eth' }, undefined, 200);
    mainnetNode.stall = false;
    expect(r).toMatchObject({ reason: 'lookup_failed' });
    expect(Date.now() - started).toBeLessThan(2_000);
    const timeout = new Promise((_, late) => setTimeout(() => late(new Error('request still open')), 1_000));
    await expect(Promise.race([Promise.all(mainnetNode.closed.slice(before)), timeout])).resolves.toBeDefined();
    await new Promise((settle) => setTimeout(settle, 500));
    expect(mainnetNode.requests - before).toBe(1);
  });
});

describe('jaw_resolve_name', () => {
  let token: string;
  beforeAll(async () => {
    await useTestDb();
    token = (await connect(undefined, { scope: 'wallet:read' })).access_token;
  });

  it('given only wallet:read, runs and refuses a bad name with its reason', async () => {
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

  it('given a mainnet node that drops the connection, answers lookup_failed', async () => {
    const r = await callTool(token, 'jaw_resolve_name', { name: 'vitalik.eth' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ reason: 'lookup_failed' });
  });
});
