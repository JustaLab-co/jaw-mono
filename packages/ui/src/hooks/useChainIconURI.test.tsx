// @vitest-environment jsdom
// The chain icon comes from wallet_getCapabilities, which the proxy now serves to a
// dApp registered by origin. Refusing to fetch without a key left keyless dApps with
// the '?' placeholder on the confirm screen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', () => ({
  handleGetCapabilitiesRequest: vi.fn(),
}));

import { handleGetCapabilitiesRequest } from '@jaw.id/core';
import { useChainIconURI } from './useChainIconURI';

const capabilitiesMock = vi.mocked(handleGetCapabilitiesRequest);

const ICON = 'https://icons.example/base.png';
const OTHER_ICON = 'https://icons.example/optimism.png';

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

  // The response is cached a layer below, in handleGetCapabilitiesRequest, which
  // is also where concurrent callers are merged into one request.
  it('asks on every mount', async () => {
    capabilitiesMock.mockResolvedValue({ '0x1': { chainMetadata: { icon: ICON } } } as never);
    await mount(1, 'test-key');
    if (root) act(() => root.unmount());
    await mount(1, 'test-key');

    expect(capabilitiesMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });

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

  it('falls back for a chain the backend has no icon for', async () => {
    capabilitiesMock.mockResolvedValue({ '0x1': {} } as never);
    await mount(1, 'test-key');

    expect(container.querySelector('img')).toBeNull();
  });

  // The dialog stays mounted when the user switches chain, and the icon it is
  // showing is the old one until the new lookup lands.
  it('drops the previous chain icon while the next one loads', async () => {
    capabilitiesMock.mockResolvedValue({ '0x1': { chainMetadata: { icon: ICON } } } as never);
    await mount(1, 'test-key');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);

    let resolveSecond: (value: unknown) => void = () => undefined;
    capabilitiesMock.mockReturnValue(new Promise((resolve) => (resolveSecond = resolve)) as never);
    await act(async () => {
      root!.render(createElement(Probe, { chainId: 10, apiKey: 'test-key' }));
    });

    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      resolveSecond({ '0xa': { chainMetadata: { icon: OTHER_ICON } } });
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(OTHER_ICON);
  });

  it('does not fetch without a chain', async () => {
    await mount(0, 'test-key');

    expect(capabilitiesMock).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
  });
});
