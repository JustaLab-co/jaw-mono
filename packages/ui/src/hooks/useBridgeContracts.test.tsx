// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { BRIDGE_CHAINS } from '../utils/bridgeCalls/contracts';
import type { BridgeContracts } from '../utils/bridgeCalls/table';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answer = (version: number) =>
  new Response(JSON.stringify({ result: JSON.parse(JSON.stringify({ version, chains: BRIDGE_CHAINS })) }));

const core = await vi.importActual('@jaw.id/core');

let root: Root;
let seen: BridgeContracts[];
let act: typeof import('react').act;
let createRoot: typeof import('react-dom/client').createRoot;
let useBridgeContracts: typeof import('./useBridgeContracts').useBridgeContracts;
let currentContracts: typeof import('../utils/bridgeCalls/load').currentContracts;

function Probe({ apiKey, tick }: { apiKey?: string; tick: number }) {
  void tick;
  seen.push(useBridgeContracts(apiKey));
  return null;
}

const mount = async (tick: number) => {
  await act(async () => root.render(<Probe apiKey="key" tick={tick} />));
};

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  vi.doMock('@jaw.id/core', () => core);
  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ useBridgeContracts } = await import('./useBridgeContracts'));
  ({ currentContracts } = await import('../utils/bridgeCalls/load'));
  seen = [];
  root = createRoot(document.createElement('div'));
  vi.spyOn(console, 'warn').mockReturnValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('given a dialog that reads the bridge table', () => {
  it('when it mounts with nothing loaded, then it gets the snapshot at once and keeps it after the refresh lands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(2)));
    await mount(0);
    await mount(1);
    expect(currentContracts()).toMatchObject({ version: 2, source: 'live' });
    expect(seen[0]).toMatchObject({ version: 1, source: 'snapshot' });
    expect(new Set(seen).size).toBe(1);
  });

  it('when a refresh has landed before the next dialog mounts, then that dialog gets the new table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(2)));
    await mount(0);
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await mount(0);
    expect(seen.at(-1)).toMatchObject({ version: 2, source: 'live' });
  });

  it('when the request fails, then the dialog keeps the snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await mount(0);
    expect(seen.at(-1)).toMatchObject({ version: 1, source: 'snapshot' });
  });
});
