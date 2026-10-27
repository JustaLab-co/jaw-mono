// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { BRIDGE_CHAINS } from '../utils/bridgeCalls/contracts';
import type { BridgeContracts } from '../utils/bridgeCalls/table';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answer = (version: number) =>
  new Response(JSON.stringify({ result: JSON.parse(JSON.stringify({ version, chains: BRIDGE_CHAINS })) }));

const answerAfter = (ms: number, version: number) =>
  vi.fn().mockImplementation(() => new Promise<Response>((resolve) => setTimeout(() => resolve(answer(version)), ms)));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

const core = await vi.importActual('@jaw.id/core');

let root: Root;
let seen: BridgeContracts[];
let settled: boolean[];
let act: typeof import('react').act;
let createRoot: typeof import('react-dom/client').createRoot;
let useBridgeContracts: typeof import('./useBridgeContracts').useBridgeContracts;
let currentContracts: typeof import('../utils/bridgeCalls/load').currentContracts;

function Probe({ apiKey, tick }: { apiKey?: string; tick: number }) {
  void tick;
  const table = useBridgeContracts(apiKey);
  seen.push(table.contracts);
  settled.push(table.settled);
  return null;
}

const mount = async (tick: number) => {
  await act(async () => root.render(<Probe apiKey="key" tick={tick} />));
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  localStorage.clear();
  vi.resetModules();
  vi.doMock('@jaw.id/core', () => core);
  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ useBridgeContracts } = await import('./useBridgeContracts'));
  ({ currentContracts } = await import('../utils/bridgeCalls/load'));
  seen = [];
  settled = [];
  root = createRoot(document.createElement('div'));
  vi.spyOn(console, 'warn').mockReturnValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('given a dialog that reads the bridge table', () => {
  it('when it mounts with nothing loaded, then it gets the snapshot at once and keeps it after the refresh lands', async () => {
    vi.stubGlobal('fetch', answerAfter(2000, 3));
    await mount(0);
    await mount(1);
    await wait(2000);
    expect(currentContracts()).toMatchObject({ version: 3, source: 'live' });
    expect(seen[0]).toMatchObject({ version: 2, source: 'snapshot' });
    expect(new Set(seen).size).toBe(1);
  });

  it('when a refresh has landed before the next dialog mounts, then that dialog gets the new table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(3)));
    await mount(0);
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await mount(0);
    expect(seen.at(-1)).toMatchObject({ version: 3, source: 'live' });
  });

  it('when the request fails, then the dialog keeps the snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await mount(0);
    expect(seen.at(-1)).toMatchObject({ version: 2, source: 'snapshot' });
  });

  it('when the answer lands within 1.5 s of mounting on the snapshot, then the open dialog switches once to the live table', async () => {
    vi.stubGlobal('fetch', answerAfter(200, 3));
    await mount(0);
    expect(seen.at(-1)).toMatchObject({ version: 2, source: 'snapshot' });
    await wait(200);
    expect(seen.at(-1)).toMatchObject({ version: 3, source: 'live' });
    expect(new Set(seen).size).toBe(2);
  });

  it('when the answer lands after 1.5 s, then the open dialog keeps the snapshot and the next one gets the live table', async () => {
    vi.stubGlobal('fetch', answerAfter(2000, 3));
    await mount(0);
    await wait(2000);
    expect(new Set(seen).size).toBe(1);
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await mount(0);
    expect(seen.at(-1)).toMatchObject({ version: 3, source: 'live' });
  });

  it('when the dialog mounted on a stored table, then a newer answer at 200 ms does not switch it', async () => {
    localStorage.setItem('jaw.bridgeContracts', JSON.stringify({ version: 3, chains: BRIDGE_CHAINS }));
    vi.stubGlobal('fetch', answerAfter(200, 4));
    await mount(0);
    await wait(200);
    expect(currentContracts().version).toBe(4);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatchObject({ version: 3, source: 'live' });
  });

  it.each([
    ['the request fails', () => vi.fn().mockRejectedValue(new Error('offline'))],
    ['the proxy answers a table that fails its invariants', () => vi.fn().mockResolvedValue(answer(2.5))],
  ])('when %s within the window, then the dialog keeps the snapshot', async (_name, fetchMock) => {
    vi.stubGlobal('fetch', fetchMock());
    await mount(0);
    await wait(300);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatchObject({ version: 2, source: 'snapshot' });
  });

  it('when the dialog closes before the answer, then nothing renders or warns afterwards', async () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    vi.stubGlobal('fetch', answerAfter(200, 3));
    await mount(0);
    act(() => root.unmount());
    const renders = seen.length;
    await wait(300);
    expect(seen.length).toBe(renders);
    expect(error).not.toHaveBeenCalled();
  });

  it('when it mounts on the snapshot with the request pending, then the table is not settled until the switch', async () => {
    vi.stubGlobal('fetch', answerAfter(200, 3));
    await mount(0);
    expect(settled.at(-1)).toBe(false);
    await wait(200);
    expect(settled.at(-1)).toBe(true);
  });

  it('when no answer comes, then the table settles when the 1.5 s window closes', async () => {
    vi.stubGlobal('fetch', answerAfter(5000, 3));
    await mount(0);
    await wait(1499);
    expect(settled.at(-1)).toBe(false);
    await wait(1);
    expect(settled.at(-1)).toBe(true);
  });

  it('when it mounts on a stored table, then the table is settled at once', async () => {
    localStorage.setItem('jaw.bridgeContracts', JSON.stringify({ version: 3, chains: BRIDGE_CHAINS }));
    vi.stubGlobal('fetch', answerAfter(5000, 4));
    await mount(0);
    expect(settled).toEqual([true]);
  });

  it('when the request fails, then the table settles on the snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await mount(0);
    expect(settled.at(-1)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ source: 'snapshot' });
  });
});
