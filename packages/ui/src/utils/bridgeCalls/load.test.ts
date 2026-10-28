// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHAINS } from './contracts';

const HOUR = 60 * 60 * 1000;
const STORAGE_KEY = 'jaw.bridgeContracts';

const tableAt = (version: number) => JSON.parse(JSON.stringify({ version, chains: BRIDGE_CHAINS }));
const answer = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status });
const sentParams = (call: number) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body)).params[0];

const core = await vi.importActual('@jaw.id/core');
const fetchMock = vi.fn<typeof fetch>();

let currentContracts: typeof import('./load').currentContracts;
let load: typeof import('./load').load;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'warn').mockReturnValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  vi.resetModules();
  vi.doMock('@jaw.id/core', () => core);
  ({ currentContracts, load } = await import('./load'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('given the bridge table loader', () => {
  it('when nothing was loaded, then the table compiled into the build is in use', () => {
    expect(currentContracts()).toMatchObject({ version: 3, source: 'snapshot' });
  });

  it('when the proxy answers with a newer table, then it is in use and kept in storage', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    await load('key');
    expect(currentContracts()).toMatchObject({ version: 4, source: 'live' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ version: 4 });
  });

  it('when it asks, then it posts jaw_getBridgeContracts with the schema and no have', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    await load('key');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/handle\?api-key=key$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'jaw_getBridgeContracts', params: [{ schema: 1 }] });
    expect(sentParams(0)).not.toHaveProperty('have');
  });

  it('when it asks without an api key, then the url carries none', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    await load();
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('api-key');
  });

  it('when a fresh table is held, then asking again within the hour makes no request', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    await load('key');
    vi.setSystemTime(Date.now() + HOUR - 1000);
    await load('key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('when the hour is over, then it asks again with the version it holds', async () => {
    fetchMock.mockResolvedValueOnce(answer(tableAt(4))).mockResolvedValueOnce(answer(tableAt(5)));
    await load('key');
    vi.setSystemTime(Date.now() + HOUR + 1000);
    await load('key');
    expect(sentParams(1)).toEqual({ schema: 1, have: 4 });
    expect(currentContracts().version).toBe(5);
  });

  it('when the proxy says not modified, then the table stays and the hour restarts', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(tableAt(4)))
      .mockResolvedValueOnce(answer({ notModified: true, version: 4 }));
    await load('key');
    const held = currentContracts();
    vi.setSystemTime(Date.now() + HOUR + 1000);
    await load('key');
    vi.setSystemTime(Date.now() + HOUR - 2000);
    await load('key');
    expect(currentContracts()).toBe(held);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('when two callers ask at once, then one request serves both', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    await Promise.all([load('key'), load('key')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the network fails', () => fetchMock.mockRejectedValue(new Error('offline'))],
    ['the proxy answers 500', () => fetchMock.mockResolvedValue(new Response('no', { status: 500 }))],
    [
      'the proxy answers a JSON-RPC error',
      () => fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: -32603, message: 'no row' } }))),
    ],
  ])('when %s, then the snapshot stays and the next call asks again', async (_name, fail) => {
    fail();
    await load('key');
    expect(currentContracts()).toMatchObject({ version: 3, source: 'snapshot' });
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    await load('key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(currentContracts().version).toBe(4);
  });

  it('when the body fails an invariant, then the snapshot stays and the console says why', async () => {
    const bad = tableAt(4);
    bad.chains['8453'].relay.depository = bad.chains['8453'].across.spokePool;
    fetchMock.mockResolvedValue(answer(bad));
    await load('key');
    expect(currentContracts().source).toBe('snapshot');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('an address holds two roles'));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('when the proxy serves a version older than the build, then the live table is used and kept', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(1)));
    await load('key');
    expect(currentContracts()).toMatchObject({ version: 1, source: 'live' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ version: 1 });
  });

  it('when the proxy serves a version older than the build, then the build chains and fields stay', async () => {
    const table = tableAt(1);
    delete table.chains['4663'].across.lifiDiamond;
    delete table.chains['100'];
    table.chains['8453'].name = 'Elsewhere';
    table.chains['8453'].across.spokePool = '0x1111111111111111111111111111111111111111';
    fetchMock.mockResolvedValue(answer(table));
    await load('key');
    const contracts = currentContracts();
    expect(contracts.chain(100)).toEqual(BRIDGE_CHAINS[100]);
    expect(contracts.chain(4663)?.across?.lifiDiamond).toBe(BRIDGE_CHAINS[4663].across!.lifiDiamond);
    expect(contracts.chain(8453)?.name).toBe(BRIDGE_CHAINS[8453].name);
    expect(contracts.chain(8453)?.across?.spokePool).toBe('0x1111111111111111111111111111111111111111');
  });

  it('when the proxy serves an older version than the one held but not older than the build, then it replaces it', async () => {
    fetchMock.mockResolvedValueOnce(answer(tableAt(5))).mockResolvedValueOnce(answer(tableAt(4)));
    await load('key');
    vi.setSystemTime(Date.now() + HOUR + 1000);
    await load('key');
    expect(currentContracts().version).toBe(4);
  });

  it('when storage holds a newer version than the proxy serves, then the proxy table replaces it in use and in storage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tableAt(7)));
    expect(currentContracts().version).toBe(7);
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    await load('key');
    expect(currentContracts().version).toBe(4);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ version: 4 });
  });

  it('when a table is in storage, then it is in use at once and the next load asks with its version', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tableAt(4)));
    expect(currentContracts()).toMatchObject({ version: 4, source: 'live' });
    fetchMock.mockResolvedValue(answer({ notModified: true, version: 4 }));
    await load('key');
    expect(sentParams(0)).toEqual({ schema: 1, have: 4 });
  });

  it.each([
    ['unparseable', 'not json'],
    ['failing an invariant', JSON.stringify({ version: 7, chains: {} })],
  ])('when the stored table is %s, then the snapshot is in use', (_name, text) => {
    localStorage.setItem(STORAGE_KEY, text);
    expect(currentContracts()).toMatchObject({ version: 3, source: 'snapshot' });
  });

  it('when storage throws on every access, then the loaded table is still in use', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    fetchMock.mockResolvedValue(answer(tableAt(4)));
    expect(currentContracts().source).toBe('snapshot');
    await load('key');
    expect(currentContracts().version).toBe(4);
  });
});

describe('given a live table that differs from the one compiled into the build', () => {
  const OTHER = '0x1111111111111111111111111111111111111111';
  const SOLVER_GONE = BRIDGE_CHAINS[4663].relay!.solvers[1];

  const loaded = async (change: (table: ReturnType<typeof tableAt>) => void) => {
    const table = tableAt(4);
    change(table);
    fetchMock.mockResolvedValue(answer(table));
    await load('key');
    return currentContracts();
  };

  it('when it lacks Across on a chain the build pins, then that chain still reads Across from the build', async () => {
    const contracts = await loaded((t) => delete t.chains['4663'].across);
    expect(contracts).toMatchObject({ version: 4, source: 'live' });
    expect(contracts.chain(4663)?.across).toEqual(BRIDGE_CHAINS[4663].across);
  });

  it('when it lacks the LiFi diamond, then the diamond of the build stays', async () => {
    const contracts = await loaded((t) => delete t.chains['4663'].across.lifiDiamond);
    expect(contracts.chain(4663)?.across?.lifiDiamond).toBe(BRIDGE_CHAINS[4663].across!.lifiDiamond);
  });

  it('when it carries another SpokePool for a chain, then that one is in use', async () => {
    const contracts = await loaded((t) => (t.chains['8453'].across.spokePool = OTHER));
    expect(contracts.chain(8453)?.across?.spokePool).toBe(OTHER);
    expect(contracts.chain(8453)?.across?.swapRouter).toBe(BRIDGE_CHAINS[8453].across!.swapRouter);
  });

  it('when it carries another swap router, then the one of the build stays', async () => {
    const contracts = await loaded((t) => (t.chains['8453'].across.swapRouter = OTHER));
    expect(contracts.chain(8453)?.across?.swapRouter).toBe(BRIDGE_CHAINS[8453].across!.swapRouter);
  });

  it('when its solver list lacks one the build lists, then that solver is gone', async () => {
    const contracts = await loaded((t) => {
      t.chains['4663'].relay.solvers = t.chains['4663'].relay.solvers.filter((s: string) => s !== SOLVER_GONE);
    });
    const solvers = contracts.chain(4663)?.relay?.solvers;
    expect(solvers).not.toContain(SOLVER_GONE);
    expect(solvers).toHaveLength(BRIDGE_CHAINS[4663].relay!.solvers.length - 1);
  });

  it('when it adds Across or Relay to a chain the build pins without one, then that chain still has none', async () => {
    const contracts = await loaded((t) => {
      t.chains['100'].across = t.chains['8453'].across;
      t.chains['421614'].relay = { ...t.chains['84532'].relay, protocolChain: 'arbitrum-sepolia' };
    });
    expect(contracts).toMatchObject({ version: 4, source: 'live' });
    expect(contracts.chain(100)?.across).toBeUndefined();
    expect(contracts.chain(421614)?.relay).toBeUndefined();
  });

  it('when it carries another LiFi diamond, then the one of the build stays', async () => {
    const contracts = await loaded((t) => (t.chains['4663'].across.lifiDiamond = OTHER));
    expect(contracts.chain(4663)?.across?.lifiDiamond).toBe(BRIDGE_CHAINS[4663].across!.lifiDiamond);
  });

  it('when it marks a mainnet Relay entry as testnet, then the entry stays mainnet', async () => {
    const contracts = await loaded((t) => (t.chains['8453'].relay.testnet = true));
    expect(contracts.chain(8453)?.relay?.testnet).toBeUndefined();
  });

  it('when it swaps the Relay names of two chains, then each keeps the name of the build', async () => {
    const contracts = await loaded((t) => {
      t.chains['8453'].relay.protocolChain = 'arbitrum';
      t.chains['42161'].relay.protocolChain = 'base';
    });
    expect(contracts).toMatchObject({ version: 4, source: 'live' });
    expect(contracts.relayByProtocolChain('base')?.chainId).toBe(8453);
    expect(contracts.relayByProtocolChain('arbitrum')?.chainId).toBe(42161);
  });

  it('when it carries other names, native symbols or tokens, then those of the build stay', async () => {
    const contracts = await loaded((t) => {
      t.chains['8453'].name = 'Elsewhere';
      t.chains['8453'].nativeSymbol = 'XYZ';
      t.chains['8453'].tokens = { [OTHER]: { symbol: 'USDC', decimals: 6 } };
    });
    const { name, nativeSymbol, tokens } = BRIDGE_CHAINS[8453];
    expect(contracts.chain(8453)).toMatchObject({ name, nativeSymbol, tokens });
    expect(contracts.chain(8453)?.tokens).not.toHaveProperty(OTHER);
  });

  it('when it is in use, then storage keeps the body the proxy sent', async () => {
    const table = tableAt(4);
    delete table.chains['4663'].across;
    fetchMock.mockResolvedValue(answer(table));
    await load('key');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(table);
  });

  it('when the stored table is older than the build, then it is in use', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tableAt(2)));
    expect(currentContracts()).toMatchObject({ version: 2, source: 'live' });
  });

  it('when it carries a chain the build lacks, then that chain is unknown', async () => {
    const contracts = await loaded((t) => {
      const { relay, ...rest } = t.chains['100'];
      t.chains['999'] = { ...rest, name: 'Elsewhere', relay: { ...relay, protocolChain: 'elsewhere' } };
    });
    expect(contracts.chain(999)).toBeUndefined();
  });

  it('when its override makes an address hold two roles, then the build stays and the console says why', async () => {
    const contracts = await loaded((t) => {
      delete t.chains['8453'].across.swapRouter;
      t.chains['8453'].across.spokePool = BRIDGE_CHAINS[8453].across!.swapRouter;
    });
    expect(contracts).toMatchObject({ version: 3, source: 'snapshot' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('an address holds two roles'));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('when it sits in storage, then it is merged with the build on read', () => {
    const table = tableAt(4);
    delete table.chains['4663'].across.lifiDiamond;
    table.chains['8453'].across.spokePool = OTHER;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
    const contracts = currentContracts();
    expect(contracts).toMatchObject({ version: 4, source: 'live' });
    expect(contracts.chain(4663)?.across?.lifiDiamond).toBe(BRIDGE_CHAINS[4663].across!.lifiDiamond);
    expect(contracts.chain(8453)?.across?.spokePool).toBe(OTHER);
  });
});
