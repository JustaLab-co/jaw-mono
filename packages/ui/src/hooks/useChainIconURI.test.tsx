// @vitest-environment jsdom
// The chain icon comes from wallet_getCapabilities, which the proxy now serves to a
// dApp registered by origin. Refusing to fetch without a key left keyless dApps with
// the '?' placeholder on the confirm screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', () => ({
  handleGetCapabilitiesRequest: vi.fn(),
}));

import { handleGetCapabilitiesRequest } from '@jaw.id/core';
import { clearChainIconCache, useChainIconURI } from './useChainIconURI';

const capabilitiesMock = vi.mocked(handleGetCapabilitiesRequest);

const ICON = 'https://icons.example/base.png';

function Probe({ chainId, apiKey }: { chainId: number; apiKey?: string }) {
  return useChainIconURI(chainId, apiKey, 24);
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(chainId: number, apiKey?: string) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe, { chainId, apiKey }));
  });
  await act(() => Promise.resolve());
}

beforeEach(() => {
  clearChainIconCache();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.clearAllMocks();
});

describe('useChainIconURI', () => {
  it('renders the icon a keyed caller gets back', async () => {
    capabilitiesMock.mockResolvedValue({ '0x1': { chainMetadata: { icon: ICON } } } as never);
    await mount(1, 'test-key');

    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });

  // Keys extracts the key from the rpc url, so a keyless dApp arrives as ''.
  it.each([undefined, ''])('fetches and renders with no key (%o)', async (apiKey) => {
    capabilitiesMock.mockResolvedValue({ '0x1': { chainMetadata: { icon: ICON } } } as never);
    await mount(1, apiKey);

    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(capabilitiesMock.mock.calls[0][1]).toBe(apiKey);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });

  // The two spellings of "no key" are the same caller, so they share an entry.
  it('serves the cached icon whichever way the missing key is spelled', async () => {
    capabilitiesMock.mockResolvedValue({ '0x1': { chainMetadata: { icon: ICON } } } as never);
    await mount(1, '');
    if (root) act(() => root.unmount());
    await mount(1, undefined);

    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });

  // A refused lookup used to be cached, which pinned the '?' placeholder for the
  // rest of the page over one offline moment.
  it('tries again after a failed lookup', async () => {
    capabilitiesMock.mockRejectedValueOnce(new Error('offline'));
    await mount(1, 'test-key');
    expect(container.querySelector('img')).toBeNull();

    if (root) act(() => root.unmount());
    capabilitiesMock.mockResolvedValue({ '0x1': { chainMetadata: { icon: ICON } } } as never);
    await mount(1, 'test-key');

    expect(capabilitiesMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });

  // A chain the backend knows nothing about is an answer, and it is cached.
  it('asks once for a chain that has no icon', async () => {
    capabilitiesMock.mockResolvedValue({ '0x1': {} } as never);
    await mount(1, 'test-key');
    if (root) act(() => root.unmount());
    await mount(1, 'test-key');

    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not fetch without a chain', async () => {
    await mount(0, 'test-key');

    expect(capabilitiesMock).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
  });
});
