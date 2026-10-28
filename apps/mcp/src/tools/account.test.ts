import { eq } from 'drizzle-orm';
import { clearCapabilitiesCache, getSupportedChains, JAW_RPC_URL } from '@jaw.id/core';
import { usdcForNetwork } from '@jaw.id/agent';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyBearer, type Tenant } from '@/connections/auth';
import { callTool, connect, mcp, setTestEnv } from '@/connections/testkit';
import { getDb } from '@/db/client';
import { connections, ownerCalls, sends } from '@/db/schema';
import { useTestDb } from '@/db/test-db';
import { chainName, listed, networkName } from '@/lib/owner-text';
import { leaks, spoken, toAgent } from '@/test-utils/spoken';

const KEY = 'proxy-key-5f3a9c';
vi.mock('@jaw.id/core', async (original) => {
  const core = await original<typeof import('@jaw.id/core')>();
  const extra = Array.from({ length: 25 }, (_, i) => ({ id: 900_001 + i }));
  return {
    ...core,
    getSupportedChains: (testnets?: boolean) => [...core.getSupportedChains(testnets), ...(testnets ? [] : extra)],
  };
});

setTestEnv();
process.env.JAW_MCP_API_KEY = KEY;

type Param = { chainFilter: string[]; account: string; assetTypeFilter: string[] };
type Rpc = { method: string; params: Param[] };
type Answer = (rpc: Rpc, url: string) => Response | unknown | Promise<unknown>;

const seen: { rpc: Rpc; url: string }[] = [];
let answer: Answer = () => [];

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith(JAW_RPC_URL)) return realFetch(input, init);
  const rpc = JSON.parse(String(init?.body)) as Rpc;
  seen.push({ rpc, url });
  const out = await answer(rpc, url);
  return out instanceof Response ? out : Response.json({ jsonrpc: '2.0', id: 1, result: out });
});

const mainnets = getSupportedChains(false).map((c) => c.id);
// Ethereum, Optimism, Gnosis, BSC, Unichain, Polygon, Soneium, Base, Arbitrum, Celo, Avalanche, Linea, Ink,
// Robinhood Chain, Arc, Monad: what the owner sees when no network is named.
const defaults = [1, 10, 100, 56, 130, 137, 1868, 8453, 42161, 42220, 43114, 59144, 57073, 4663, 5042, 143];
const FLARE = 14;
const hex = (id: number) => `0x${id.toString(16)}`;
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ether = { address: null, balance: '0xde0b6b3a7640000', type: 'native', metadata: null };
const usdc = (balance: string) => ({
  address: USDC_ARB,
  balance,
  type: 'erc20',
  metadata: { decimals: 6, name: 'USD Coin', symbol: 'USDC' },
});

let token: string;
let account: string;
beforeAll(async () => {
  await useTestDb();
  const c = await connect(undefined, { scope: 'wallet:read' });
  token = c.access_token;
  account = c.signer.address;
});
afterEach(() => {
  clearCapabilitiesCache();
  seen.length = 0;
  answer = () => [];
});

describe('jaw_get_assets', () => {
  it('given no networks, then it asks for each default network in its own request and merges the answers', async () => {
    answer = ({ params }) => Object.fromEntries(params[0].chainFilter.map((id) => [id, [ether]]));

    const r = await callTool(token, 'jaw_get_assets', {});

    const asked = seen.map((s) => s.rpc.params[0].chainFilter);
    expect(asked.every((c) => c.length === 1)).toBe(true);
    expect(asked.flat().sort()).toEqual(defaults.map(hex).sort());
    expect(seen.every((s) => s.rpc.method === 'wallet_getAssets' && s.rpc.params[0].account === account)).toBe(true);
    expect(r.structuredContent.chains.map((c: { chainId: string }) => c.chainId).sort()).toEqual(
      defaults.map((id) => `eip155:${id}`).sort()
    );
    expect(r.structuredContent.failed).toEqual([]);
    expect(r.structuredContent).not.toHaveProperty('unreported');
    expect(r.structuredContent.summary).not.toContain('Not reported');
  });

  it('given a token on a mainnet other than Base, then it lists it with decimals, symbol, name and a decimal balance', async () => {
    answer = ({ params }) => ({
      ...(params[0].chainFilter.includes(hex(8453)) && { [hex(8453)]: [ether] }),
      ...(params[0].chainFilter.includes(hex(42161)) && { [hex(42161)]: [usdc('0x2faf080')] }),
    });

    const r = await callTool(token, 'jaw_get_assets', {});

    const arbitrum = r.structuredContent.chains.find((c: { chainId: string }) => c.chainId === 'eip155:42161');
    expect(arbitrum.assets).toEqual([
      { type: 'erc20', address: USDC_ARB, balance: '50000000', decimals: 6, symbol: 'USDC', name: 'USD Coin' },
    ]);
  });

  it('given a supported network outside the defaults, then it is read only when named', async () => {
    answer = ({ params }) => Object.fromEntries(params[0].chainFilter.map((id) => [id, [ether]]));
    const others = mainnets.filter((id) => !defaults.includes(id));
    expect(others).toContain(FLARE);

    await callTool(token, 'jaw_get_assets', {});
    const byDefault = seen.splice(0).flatMap((s) => s.rpc.params[0].chainFilter);
    const named = await callTool(token, 'jaw_get_assets', { chainIds: [FLARE, others.at(-1)!] });

    expect(byDefault).not.toEqual(expect.arrayContaining([hex(FLARE)]));
    expect(others.some((id) => byDefault.includes(hex(id)))).toBe(false);
    expect(named.isError).toBeFalsy();
    expect(named.structuredContent.chains.map((c: { chainId: string }) => c.chainId)).toEqual(
      [FLARE, others.at(-1)!].sort((a, b) => a - b).map((id) => `eip155:${id}`)
    );
  });

  it('given the tools list, then jaw_get_assets names its default networks and that others are read on request', async () => {
    const { json } = await mcp(token, { method: 'tools/list' });

    const tool = json.result.tools.find((x: { name: string }) => x.name === 'jaw_get_assets');
    expect(tool.description).toContain(`reads ${listed(defaults.map(networkName))}, and this connection's network`);
    expect(tool.description).toContain('read one of those only when the owner names it or added funds on it');
  });

  it('given a chain the proxy refuses, then the others are returned and the lost chain is named without the key', async () => {
    answer = ({ params }, url) =>
      params[0].chainFilter[0] === hex(defaults[3])
        ? new Response(`upstream said no to ${url}`, { status: 500 })
        : Object.fromEntries(params[0].chainFilter.map((id) => [id, [ether]]));

    const r = await callTool(token, 'jaw_get_assets', {});

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.chains).toHaveLength(defaults.length - 1);
    expect(r.structuredContent.failed).toEqual([
      { chainIds: [`eip155:${defaults[3]}`], reason: expect.stringContaining('500') },
    ]);
    expect(r.structuredContent.summary).toContain(`Could not read ${chainName(defaults[3])} right now`);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('given every chain fails, then it is an error that does not carry the key', async () => {
    answer = (_rpc, url) => new Response(`down: ${url}`, { status: 502 });

    const r = await callTool(token, 'jaw_get_assets', {});

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^proxy_error: /);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('given a testnet chain id, then it refuses before asking the proxy', async () => {
    const r = await callTool(token, 'jaw_get_assets', { chainIds: [11155111] });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^not_a_mainnet: Sepolia is not among the networks the wallet reads\./);
    expect(r.content[0].text).toContain('Not supported mainnets: 11155111.');
    expect(leaks(spoken(r))).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('given a token whose name tries to speak to the model, then control characters are gone and the name is cut', async () => {
    answer = () => ({
      [hex(1)]: [{ ...usdc('0x1'), metadata: { decimals: 6, symbol: 'S‮X', name: `${'N'.repeat(200)}\u001b[2K` } }],
    });

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [1] });

    const [asset] = r.structuredContent.chains[0].assets;
    expect(asset.name).toMatch(/^N{64}\u2026 \(\d+ more characters\)$/);
    expect(asset.symbol).not.toContain('‮');
    expect(asset.name).not.toContain('\u001b');
  });
});

describe('jaw_get_calls_history', () => {
  it('given no address, then the proxy is asked for the connected account', async () => {
    answer = () => [{ id: '0xabc', index: 7, chainId: 8453, status: 200, transactionHash: '0xdef' }];

    const r = await callTool(token, 'jaw_get_calls_history', { limit: 5 });

    expect(seen).toHaveLength(1);
    expect(seen[0].rpc).toMatchObject({
      method: 'wallet_getCallsHistory',
      params: [{ address: account, limit: 5 }],
    });
    expect(r.structuredContent.calls).toEqual([expect.objectContaining({ id: '0xabc', index: 7 })]);
  });

  describe('given bundles the proxy still lists as pending that this connection saw land', () => {
    const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    const pending = (id: string) => ({ id, index: 1, chainId: 84532, status: 100, transactionHash: null });

    async function landed(t: Tenant) {
      const now = new Date();
      await getDb()
        .insert(sends)
        .values({
          id: 'send_hist',
          connectionId: t.connectionId,
          permissionId: '0x01',
          chainId: t.chainId,
          sender: t.sessionAddress.toLowerCase(),
          amount: '0',
          periodStart: 0,
          fromBlock: 1n,
          state: 'landed',
          callsId: hash(0xa1),
          txHash: hash(0xb1),
          leaseUntil: now,
          finishedAt: now,
        });
      await getDb()
        .insert(ownerCalls)
        .values({
          id: 'oc_hist',
          connectionId: t.connectionId,
          idempotencyKey: 'hist',
          requestHash: 'h',
          chainId: t.chainId,
          account: t.account,
          calls: [{ to: t.account, data: '0x', value: '0' }],
          state: 'landed',
          walletUrl: 'http://keys.test/cli-bridge',
          approveBy: now,
          callsId: hash(0xa2).toUpperCase().replace('0X', '0x'),
          txHash: hash(0xb2),
          finishedAt: now,
        });
    }

    it('then each row carries what this connection recorded, apart from the proxy fields, and the summary says so', async () => {
      const t = (await verifyBearer(token))?.extra?.tenant as Tenant;
      await landed(t);
      answer = () => [pending(hash(0xa1).toUpperCase().replace('0X', '0x')), pending(hash(0xa2)), pending(hash(0xa3))];

      const r = await callTool(token, 'jaw_get_calls_history', {});

      const [session, owner, unknown] = r.structuredContent.calls;
      expect(session).toMatchObject({ status: 100, transactionHash: null });
      expect(session.thisConnection).toEqual({ state: 'landed', transactionHash: hash(0xb1) });
      expect(owner.thisConnection).toEqual({ state: 'landed', transactionHash: hash(0xb2) });
      expect(unknown.thisConnection).toBeUndefined();
      expect(r.structuredContent.summary).toContain('2 shown as pending already went through.');
      expect(r.structuredContent.summary).toContain(
        'For the agent: Those are marked thisConnection with the final state and hash.'
      );
      expect(leaks(spoken(r))).toEqual([]);
      expect(spoken(r)).toBe('3 transactions, newest first. 2 shown as pending already went through.');
    });

    it("then a row in another state or on another connection's record is not marked", async () => {
      const t = (await verifyBearer(token))?.extra?.tenant as Tenant;
      const other = (await verifyBearer((await connect(undefined, { scope: 'wallet:read' })).access_token))?.extra
        ?.tenant as Tenant;
      const base = {
        idempotencyKey: 'k',
        requestHash: 'h',
        chainId: t.chainId,
        account: t.account,
        calls: [{ to: t.account, data: '0x', value: '0' }],
        walletUrl: 'http://keys.test/cli-bridge',
        approveBy: new Date(),
      };
      await getDb()
        .insert(ownerCalls)
        .values([
          { ...base, id: 'oc_sent', connectionId: t.connectionId, state: 'sent', callsId: hash(0xd1) },
          {
            ...base,
            id: 'oc_other',
            connectionId: other.connectionId,
            state: 'landed',
            callsId: hash(0xd2),
            txHash: hash(0xb3),
            finishedAt: new Date(),
          },
        ]);
      const now = new Date();
      await getDb()
        .insert(sends)
        .values({
          id: 'send_other',
          connectionId: other.connectionId,
          permissionId: '0x01',
          chainId: other.chainId,
          sender: other.sessionAddress.toLowerCase(),
          amount: '0',
          periodStart: 0,
          fromBlock: 1n,
          state: 'landed',
          callsId: hash(0xd3),
          txHash: hash(0xb4),
          leaseUntil: now,
          finishedAt: now,
        });
      await getDb()
        .insert(sends)
        .values({
          id: 'send_released',
          connectionId: t.connectionId,
          permissionId: '0x01',
          chainId: t.chainId,
          sender: t.sessionAddress.toLowerCase(),
          amount: '0',
          periodStart: 0,
          fromBlock: 1n,
          state: 'released',
          callsId: hash(0xd4),
          txHash: hash(0xb5),
          leaseUntil: now,
          finishedAt: now,
        });
      await getDb()
        .insert(ownerCalls)
        .values({
          ...base,
          id: 'oc_sent_hash',
          idempotencyKey: 'k2',
          connectionId: t.connectionId,
          state: 'sent',
          callsId: hash(0xd5),
          txHash: hash(0xb6),
        });
      answer = () => [0xd1, 0xd2, 0xd3, 0xd4, 0xd5].map((n) => pending(hash(n)));

      const r = await callTool(token, 'jaw_get_calls_history', {});

      expect(r.structuredContent.calls.map((c: { thisConnection?: unknown }) => c.thisConnection)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    });

    it('then a database failure leaves the proxy answer as it is', async () => {
      answer = () => [pending(hash(0xa1))];
      const db = getDb();
      const select = db.select.bind(db) as (...a: unknown[]) => { from: (table: unknown) => unknown };
      const broken = vi.spyOn(db, 'select').mockImplementation(((...a: unknown[]) => {
        const query = select(...a);
        return {
          ...query,
          from: (table: unknown) => {
            if (table === sends) throw new Error('db down');
            return query.from(table);
          },
        };
      }) as never);

      const r = await callTool(token, 'jaw_get_calls_history', {});
      broken.mockRestore();

      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.calls).toEqual([pending(hash(0xa1))]);
    });

    it('then a bundle the proxy has settled is left as it is', async () => {
      answer = () => [{ ...pending(hash(0xa1)), status: 200, transactionHash: hash(0xc1) }];

      const r = await callTool(token, 'jaw_get_calls_history', {});

      expect(r.structuredContent.calls[0].thisConnection).toBeUndefined();
      expect(r.structuredContent.summary).not.toContain('shown as pending');
    });
  });

  it('given a failing proxy, then it is an error', async () => {
    answer = () => new Response('nope', { status: 500 });

    const r = await callTool(token, 'jaw_get_calls_history', {});

    expect(r.isError).toBe(true);
  });
});

describe('jaw_get_permissions', () => {
  it('given a chain, then it asks for the account on that chain, whoever the spender is', async () => {
    answer = () => [{ permissionId: '0x01', spender: '0x2222222222222222222222222222222222222222' }];

    const r = await callTool(token, 'jaw_get_permissions', { chainId: 8453 });

    expect(seen[0].rpc).toMatchObject({
      method: 'wallet_getPermissions',
      params: [{ address: account, chainId: '0x2105' }],
    });
    expect(r.structuredContent.permissions).toHaveLength(1);
  });

  it('given a proxy answer that is not a list, then it is an error', async () => {
    answer = () => ({ nope: true });

    const r = await callTool(token, 'jaw_get_permissions', {});

    expect(r.isError).toBe(true);
  });
});

describe('jaw_get_capabilities', () => {
  it('given no chains, then the proxy is asked for mainnets only and the answer is keyed by CAIP-2', async () => {
    answer = ({ params }) =>
      Object.fromEntries(
        (params[1] as unknown as string[]).map((id) => [
          id,
          { atomic: { status: 'supported' }, paymasterService: { supported: true } },
        ])
      );

    const r = await callTool(token, 'jaw_get_capabilities', {});

    expect(seen[0].rpc.params[0]).toBe(account);
    expect(seen[0].rpc.params[1]).toContain(hex(8453));
    expect(seen[0].rpc.params[1]).not.toContain(hex(84532));
    expect(r.structuredContent.capabilities['eip155:8453']).toMatchObject({
      atomic: { status: 'supported' },
      paymasterService: { supported: true },
    });
    expect(Object.keys(r.structuredContent.capabilities)).not.toContain('eip155:84532');
  });
});

describe('what the proxy says reaches the model only as plain text', () => {
  it('given instructions and control characters in capabilities, permissions and history, then they come out cut and without controls', async () => {
    const evil = `fee\u202E${'x'.repeat(400)}\u001b[2K`;
    answer = ({ method }) =>
      method === 'wallet_getCapabilities'
        ? { [hex(8453)]: { feeToken: { tokens: [{ symbol: evil }] } } }
        : [{ label: evil }];

    const caps = await callTool(token, 'jaw_get_capabilities', {});
    const perms = await callTool(token, 'jaw_get_permissions', {});
    const hist = await callTool(token, 'jaw_get_calls_history', {});

    for (const r of [caps, perms, hist]) {
      const text = JSON.stringify(r.structuredContent);
      expect(text).not.toContain('\u202E');
      expect(text).not.toContain('\u001b');
      expect(text).not.toContain('x'.repeat(250));
    }
  });

  it.each(['jaw_get_calls_history', 'jaw_get_permissions', 'jaw_get_capabilities'])(
    'given a %s failure that quotes the proxy url, then the key is not in the answer',
    async (name) => {
      answer = (_rpc, url) => new Response(`bad gateway for ${url}`, { status: 502 });

      const r = await callTool(token, name, {});

      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  );
});

describe('jaw_get_assets answers', () => {
  it('given the connection chain, which is a testnet, then it is read when asked for by id and left out of the default', async () => {
    answer = ({ params }) => ({ [params[0].chainFilter[0]]: [ether] });

    const own = await callTool(token, 'jaw_get_assets', { chainIds: [84532] });
    const all = await callTool(token, 'jaw_get_assets', {});

    expect(own.structuredContent.chains.map((c: { chainId: string }) => c.chainId)).toEqual(['eip155:84532']);
    expect(JSON.stringify(seen.slice(1).map((s) => s.rpc.params[0].chainFilter))).not.toContain(hex(84532));
    expect(all.structuredContent.chains.map((c: { chainId: string }) => c.chainId)).not.toContain('eip155:84532');
  });

  it('given a chain the proxy leaves out of a good answer, then it holds nothing there, not an unknown balance', async () => {
    answer = ({ params }) => (params[0].chainFilter[0] === hex(1) ? { [hex(1)]: [ether] } : {});

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [1, 10] });

    expect(r.structuredContent.chains).toEqual([
      expect.objectContaining({ chainId: 'eip155:1' }),
      { chainId: 'eip155:10', assets: [] },
    ]);
    expect(r.structuredContent.failed).toEqual([]);
    expect(r.structuredContent).not.toHaveProperty('unreported');
    expect(r.structuredContent.summary).toBe('On Ethereum: 1 ETH.');
  });

  it('given only chains the proxy leaves out of good answers, then it says no funds were found there', async () => {
    answer = () => ({});

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [100, 56] });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.chains).toEqual([
      { chainId: 'eip155:56', assets: [] },
      { chainId: 'eip155:100', assets: [] },
    ]);
    expect(r.structuredContent.summary).toBe('No funds found on BNB Smart Chain and Gnosis.');
  });

  describe('given the read narrowed to one asset type', () => {
    // The proxy applies the type filter and leaves out a chain with nothing of those types.
    const filtered: Answer = ({ params }) => {
      const [{ chainFilter, assetTypeFilter }] = params;
      const held = [ether].filter((a) => assetTypeFilter.includes(a.type));
      return chainFilter[0] === hex(8453) && held.length ? { [hex(8453)]: held } : {};
    };

    it('given an owner with only the coin and a read for tokens, then it says no tokens, never no funds', async () => {
      answer = filtered;

      const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453], assetTypes: ['erc20'] });

      expect(seen.at(-1)?.rpc.params[0].assetTypeFilter).toEqual(['erc20']);
      expect(r.structuredContent.chains).toEqual([{ chainId: 'eip155:8453', assets: [] }]);
      expect(r.structuredContent.summary).toBe('No tokens found on Base. Only tokens were read, not the coin.');
    });

    it('given a read for the coin that finds it, then it says only the coin was read', async () => {
      answer = filtered;

      const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453], assetTypes: ['native'] });

      expect(r.structuredContent.summary).toBe('On Base: 1 ETH. Only the coin was read, not tokens.');
    });

    it('given both types named, then it reads as an unfiltered answer', async () => {
      answer = () => ({});

      const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453], assetTypes: ['erc20', 'native'] });

      expect(r.structuredContent.summary).toBe('No funds found on Base.');
    });
  });

  it('given two chains that hang and the rest answer, then the rest come back, the two time out, and it ends before 5 s', async () => {
    const hung = [defaults[0], defaults[1]].map(hex);
    answer = ({ params }) =>
      hung.includes(params[0].chainFilter[0])
        ? new Promise(() => {})
        : Object.fromEntries(params[0].chainFilter.map((id) => [id, [ether]]));

    const started = Date.now();
    const r = await callTool(token, 'jaw_get_assets', {});

    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.chains).toHaveLength(defaults.length - 2);
    expect(r.structuredContent.failed).toEqual(
      [defaults[0], defaults[1]].map((id) => ({
        chainIds: [`eip155:${id}`],
        reason: expect.stringContaining('timed out'),
      }))
    );
    expect(r.structuredContent).not.toHaveProperty('unreported');
    expect(JSON.stringify(r)).not.toContain(KEY);
  }, 10_000);

  it('given every chain hangs, then it is a proxy error before 5 s', async () => {
    answer = () => new Promise(() => {});

    const started = Date.now();
    const r = await callTool(token, 'jaw_get_assets', {});

    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^proxy_error: [\s\S]*timed out/);
    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe("The wallet's balances could not be read right now. Try again shortly.");
    expect(toAgent(r)).toEqual([expect.stringMatching(/^For the agent: .*timed out/)]);
    expect(JSON.stringify(r)).not.toContain(KEY);
  }, 10_000);

  it('given duplicate chain ids, then each is asked once', async () => {
    answer = ({ params }) => ({ [params[0].chainFilter[0]]: [ether] });

    await callTool(token, 'jaw_get_assets', { chainIds: [1, 1, 8453] });

    expect(seen.map((s) => s.rpc.params[0].chainFilter)).toEqual([[hex(1)], [hex(8453)]]);
  });

  it('given the default networks, then each is one the wallet supports', () => {
    expect(defaults.filter((id) => !mainnets.includes(id))).toEqual([]);
  });

  it('given a connection on a mainnet outside the defaults, then its chain is read first, with the defaults', async () => {
    answer = ({ params }) => Object.fromEntries(params[0].chainFilter.map((id) => [id, [ether]]));
    const flare = await connect(undefined, { scope: 'wallet:read' });
    await getDb().update(connections).set({ chainId: FLARE }).where(eq(connections.account, flare.signer.address));

    const r = await callTool(flare.access_token, 'jaw_get_assets', {});

    const asked = seen.map((s) => s.rpc.params[0].chainFilter[0]);
    expect(asked).toEqual([FLARE, ...defaults].map(hex));
    expect(r.structuredContent.chains.map((c: { chainId: string }) => c.chainId)).toContain(`eip155:${FLARE}`);
  });

  it('given a connection on a mainnet outside the defaults, then every default and its chain are read at once', async () => {
    const all = defaults.length + 1;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    answer = async ({ params }) => {
      if (seen.length === all) open();
      await gate;
      return Object.fromEntries(params[0].chainFilter.map((id) => [id, [ether]]));
    };
    const flare = await connect(undefined, { scope: 'wallet:read' });
    await getDb().update(connections).set({ chainId: FLARE }).where(eq(connections.account, flare.signer.address));

    const r = await callTool(flare.access_token, 'jaw_get_assets', {});

    expect(r.structuredContent.failed).toEqual([]);
    expect(r.structuredContent.chains).toHaveLength(all);
  });

  it('given no networks and nothing found, then the owner hears the networks read and only the agent the ones not read', async () => {
    answer = ({ params }) => Object.fromEntries(params[0].chainFilter.map((id) => [id, []]));
    const others = mainnets.filter((id) => !defaults.includes(id));

    const r = await callTool(token, 'jaw_get_assets', {});

    expect(spoken(r)).toBe(`No funds found on the ${defaults.length} networks read.`);
    expect(toAgent(r)).toEqual([
      expect.stringContaining(`Not read, since funds there are rare: ${listed(others.map(networkName))}.`),
    ]);
    expect(leaks(spoken(r))).toEqual([]);
  });

  it('given no networks and funds found, then the owner hears only the balances', async () => {
    answer = ({ params }) =>
      Object.fromEntries(params[0].chainFilter.map((id) => [id, Number(id) === 8453 ? [ether] : []]));
    const others = mainnets.filter((id) => !defaults.includes(id));

    const r = await callTool(token, 'jaw_get_assets', {});

    expect(spoken(r)).toBe('On Base: 1 ETH.');
    expect(toAgent(r)).toEqual([expect.stringContaining(listed(others.map(networkName)))]);
  });

  it('given networks named, then nothing is said about the ones left out', async () => {
    answer = ({ params }) => Object.fromEntries(params[0].chainFilter.map((id) => [id, []]));

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453] });

    expect(toAgent(r)).toEqual([]);
    expect(spoken(r)).toBe('No funds found on Base.');
  });

  it('given a chain the proxy was not asked about, then it is left out', async () => {
    answer = () => ({ [hex(1)]: [ether], [hex(84532)]: [ether] });

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [1] });

    expect(r.structuredContent.chains.map((c: { chainId: string }) => c.chainId)).toEqual(['eip155:1']);
  });
});

describe('what the owner hears from the account tools', () => {
  const h = (n: bigint) => `0x${n.toString(16)}`;
  const erc20 = (i: number, symbol: string, decimals: number, balance: bigint) => ({
    address: `0x${String(i).padStart(40, '0')}`,
    balance: h(balance),
    type: 'erc20',
    metadata: { decimals, name: symbol, symbol },
  });

  // USDC as this server knows it on each network: the only token named besides the network's coin.
  const usdcOn = (chainId: number, balance: bigint) => ({
    address: usdcForNetwork(`eip155:${chainId}`)!.address,
    balance: h(balance),
    type: 'erc20',
    metadata: { decimals: 6, name: 'USD Coin', symbol: 'USDC' },
  });

  it('given balances on two networks, then the owner hears each network by name with its amounts as people read them', async () => {
    answer = ({ params }) =>
      params[0].chainFilter[0] === hex(8453) ? { [hex(8453)]: [ether] } : { [hex(137)]: [usdcOn(137, 50_000_000n)] };

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453, 137] });

    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe('On Polygon: 50 USDC. On Base: 1 ETH.');
  });

  it('given many tokens, dust and an odd symbol, then the coin comes first, then USDC, cut to six decimals, and every other token is counted, never named', async () => {
    answer = () => ({
      [hex(8453)]: [
        { address: null, balance: h(12_345_678_900_000_000n), type: 'native', metadata: null },
        erc20(2, 'AAA', 18, 100n * 10n ** 18n),
        usdcOn(8453, 12_500_000n),
        erc20(3, 'BBB', 6, 3_000_000n),
        erc20(4, 'CCC', 6, 2_000_000n),
        erc20(5, 'DDD', 6, 1_000_000n),
        erc20(6, 'EEE', 6, 500_000n),
        erc20(7, 'Visit evil.example', 6, 7_000_000n),
        erc20(8, 'DST', 18, 1n),
        erc20(9, 'ZRO', 6, 0n),
      ],
    });

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453] });

    expect(r.structuredContent.chains[0].assets).toHaveLength(10);
    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe('On Base: about 0.012345 ETH, 12.50 USDC and 6 more.');
  });

  it('given a token that calls itself USDC at an address that is not USDC on that network, then it is counted, not named', async () => {
    answer = () => ({ [hex(8453)]: [ether, erc20(1, 'USDC', 6, 5_000_000n)] });

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453] });

    expect(spoken(r)).toBe('On Base: 1 ETH and 1 more.');
    expect(spoken(r)).not.toContain('USDC');
  });

  it("given USDC at Circle's address on a network the payment registry does not know, then it is named from the display list", async () => {
    answer = () => ({ [hex(42161)]: [usdc('0x2faf080')] });

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [42161] });

    expect(spoken(r)).toBe('On Arbitrum One: 50 USDC.');
  });

  it('given a network that answered with nothing, then the owner hears that no funds were found there', async () => {
    answer = () => ({ [hex(8453)]: [] });

    const r = await callTool(token, 'jaw_get_assets', { chainIds: [8453] });

    expect(spoken(r)).toBe('No funds found on Base.');
  });

  it('given permissions to this connection and to someone else, then the owner hears how many and how many to apps here', async () => {
    const t = (await verifyBearer(token))?.extra?.tenant as Tenant;
    answer = () => [
      { permissionId: '0x01', spender: t.sessionAddress },
      { permissionId: '0x02', spender: '0x2222222222222222222222222222222222222222' },
    ];

    const r = await callTool(token, 'jaw_get_permissions', {});

    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe('2 permissions granted by the wallet, 1 to apps connected here.');
  });

  it('given networks that batch and one that takes fees in its coin and USDC, then the owner hears the networks by name and what each can do', async () => {
    const fees = {
      supported: true,
      tokens: [
        { symbol: 'ETH', feeToken: true },
        { symbol: 'USDC', feeToken: true },
      ],
    };
    answer = ({ params }) =>
      Object.fromEntries(
        (params[1] as unknown as string[]).map((id) => [
          id,
          { atomic: { status: 'supported' }, ...(id === hex(8453) && { feeToken: fees }) },
        ])
      );

    const r = await callTool(token, 'jaw_get_capabilities', { chainIds: [8453, 42161] });

    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe(
      'The wallet works on 2 networks: Base and Arbitrum One. On each it can run several actions in one approval. On Base it can pay the network fee in ETH or USDC.'
    );
  });

  it('given networks with their own fee tokens, then each list is read from the capabilities, shared lists said once', async () => {
    const fees = (...symbols: string[]) => ({
      supported: true,
      tokens: [...symbols.map((symbol) => ({ symbol, feeToken: true })), { symbol: 'DAI', feeToken: false }],
    });
    const byChain: Record<string, unknown> = {
      [hex(10)]: { feeToken: fees('ETH', 'USDC') },
      [hex(8453)]: { feeToken: fees('ETH', 'USDC') },
      [hex(42161)]: { feeToken: fees('ETH', 'USDC', 'USD₮0', 'EURe') },
    };
    answer = ({ params }) =>
      Object.fromEntries((params[1] as unknown as string[]).map((id) => [id, byChain[id] ?? {}]));

    const r = await callTool(token, 'jaw_get_capabilities', { chainIds: [10, 8453, 42161] });

    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe(
      'The wallet works on 3 networks: OP Mainnet, Base and Arbitrum One. ' +
        'On OP Mainnet and Base it can pay the network fee in ETH or USDC. ' +
        'On Arbitrum One it can pay the network fee in ETH, USDC, USD₮0 or EURe.'
    );
  });

  it.each([
    ['jaw_get_calls_history', "The wallet's transaction history could not be read right now. Try again shortly."],
    ['jaw_get_permissions', "The wallet's permissions could not be read right now. Try again shortly."],
    ['jaw_get_capabilities', 'The networks the wallet supports could not be read right now. Try again shortly.'],
  ])('given %s fails, then the owner hears what could not be read, and the code stays first', async (name, said) => {
    answer = () => new Response('nope', { status: 500 });

    const r = await callTool(token, name, {});

    expect(r.content[0].text).toMatch(/^proxy_error: /);
    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toBe(said);
  });
});
