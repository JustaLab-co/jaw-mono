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
    expect(currentContracts()).toMatchObject({ version: 2, source: 'snapshot' });
  });

  it('when the proxy answers with a newer table, then it is in use and kept in storage', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(3)));
    await load('key');
    expect(currentContracts()).toMatchObject({ version: 3, source: 'live' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ version: 3 });
  });

  it('when it asks, then it posts jaw_getBridgeContracts with the schema and no have', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(3)));
    await load('key');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/handle\?api-key=key$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'jaw_getBridgeContracts', params: [{ schema: 1 }] });
    expect(sentParams(0)).not.toHaveProperty('have');
  });

  it('when it asks without an api key, then the url carries none', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(3)));
    await load();
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('api-key');
  });

  it('when a fresh table is held, then asking again within the hour makes no request', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(3)));
    await load('key');
    vi.setSystemTime(Date.now() + HOUR - 1000);
    await load('key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('when the hour is over, then it asks again with the version it holds', async () => {
    fetchMock.mockResolvedValueOnce(answer(tableAt(3))).mockResolvedValueOnce(answer(tableAt(4)));
    await load('key');
    vi.setSystemTime(Date.now() + HOUR + 1000);
    await load('key');
    expect(sentParams(1)).toEqual({ schema: 1, have: 3 });
    expect(currentContracts().version).toBe(4);
  });

  it('when the proxy says not modified, then the table stays and the hour restarts', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(tableAt(3)))
      .mockResolvedValueOnce(answer({ notModified: true, version: 3 }));
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
    fetchMock.mockResolvedValue(answer(tableAt(3)));
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
    expect(currentContracts()).toMatchObject({ version: 2, source: 'snapshot' });
    fetchMock.mockResolvedValue(answer(tableAt(3)));
    await load('key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(currentContracts().version).toBe(3);
  });

  it('when the body fails an invariant, then the snapshot stays and the console says why', async () => {
    const bad = tableAt(3);
    bad.chains['8453'].relay.depository = bad.chains['8453'].across.spokePool;
    fetchMock.mockResolvedValue(answer(bad));
    await load('key');
    expect(currentContracts().source).toBe('snapshot');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('an address holds two roles'));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('when the proxy serves a version older than the build, then the snapshot wins', async () => {
    fetchMock.mockResolvedValue(answer(tableAt(1)));
    await load('key');
    expect(currentContracts()).toMatchObject({ version: 2, source: 'snapshot' });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('when the proxy serves an older version than the one held but not older than the build, then it replaces it', async () => {
    fetchMock.mockResolvedValueOnce(answer(tableAt(4))).mockResolvedValueOnce(answer(tableAt(3)));
    await load('key');
    vi.setSystemTime(Date.now() + HOUR + 1000);
    await load('key');
    expect(currentContracts().version).toBe(3);
  });

  it('when storage holds a newer version than the proxy serves, then the proxy table replaces it in use and in storage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tableAt(6)));
    expect(currentContracts().version).toBe(6);
    fetchMock.mockResolvedValue(answer(tableAt(3)));
    await load('key');
    expect(currentContracts().version).toBe(3);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ version: 3 });
  });

  it('when a table is in storage, then it is in use at once and the next load asks with its version', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tableAt(3)));
    expect(currentContracts()).toMatchObject({ version: 3, source: 'live' });
    fetchMock.mockResolvedValue(answer({ notModified: true, version: 3 }));
    await load('key');
    expect(sentParams(0)).toEqual({ schema: 1, have: 3 });
  });

  it.each([
    ['unparseable', 'not json'],
    ['older than the build', JSON.stringify(tableAt(1))],
    ['failing an invariant', JSON.stringify({ version: 6, chains: {} })],
  ])('when the stored table is %s, then the snapshot is in use', (_name, text) => {
    localStorage.setItem(STORAGE_KEY, text);
    expect(currentContracts()).toMatchObject({ version: 2, source: 'snapshot' });
  });

  it('when storage throws on every access, then the loaded table is still in use', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    fetchMock.mockResolvedValue(answer(tableAt(3)));
    expect(currentContracts().source).toBe('snapshot');
    await load('key');
    expect(currentContracts().version).toBe(3);
  });
});
