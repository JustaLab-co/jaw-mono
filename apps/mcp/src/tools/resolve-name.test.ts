import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { callTool, connect, setTestEnv } from '@/connections/testkit';
import { lookup, type EnsClient } from './resolve-name';

setTestEnv();
process.env.JAW_MCP_MAINNET_RPC_URL = 'http://127.0.0.1:9';

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
    expect(await lookup({ name: 'vitalik.eth' }, client)).toMatchObject({
      name: 'vitalik.eth',
      address: VITALIK,
      chainId: 'eip155:1',
    });
  });

  it('given a name in capitals, looks up the normalized form', async () => {
    expect(await lookup({ name: 'VITALIK.eth' }, client)).toMatchObject({ name: 'vitalik.eth', address: VITALIK });
  });

  it('given an address with a primary name that points back, returns the name', async () => {
    expect(await lookup({ address: VITALIK.toLowerCase() }, client)).toMatchObject({
      name: 'vitalik.eth',
      address: VITALIK,
    });
  });

  it('given a name that does not parse, answers invalid_name', async () => {
    expect(await lookup({ name: 'a\u0000.eth' }, client)).toMatchObject({ reason: 'invalid_name', address: null });
  });

  it('given a name with no record, answers no_address and keeps the name', async () => {
    expect(await lookup({ name: 'nobody.eth' }, client)).toMatchObject({
      name: 'nobody.eth',
      address: null,
      reason: 'no_address',
    });
  });

  it('given a string that is no address, answers invalid_address', async () => {
    expect(await lookup({ address: '0x1234' }, client)).toMatchObject({ reason: 'invalid_address' });
  });

  it('given an address with no primary name, answers no_primary_name', async () => {
    expect(await lookup({ address: '0x0000000000000000000000000000000000000002' }, client)).toMatchObject({
      name: null,
      reason: 'no_primary_name',
    });
  });

  it('given a primary name that does not resolve back, does not return it', async () => {
    const r = await lookup({ address: OTHER }, client);
    expect(r).toMatchObject({ name: null, reason: 'unverified_name' });
  });

  it('given a lookup that fails, answers lookup_failed without the error text', async () => {
    const r = await lookup({ name: 'vitalik.eth' }, down);
    expect(r).toMatchObject({ reason: 'lookup_failed' });
    expect(JSON.stringify(r)).not.toContain('gateway');
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

  it('given an unreachable mainnet node, answers lookup_failed', async () => {
    const r = await callTool(token, 'jaw_resolve_name', { name: 'vitalik.eth' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ reason: 'lookup_failed' });
  });
});
