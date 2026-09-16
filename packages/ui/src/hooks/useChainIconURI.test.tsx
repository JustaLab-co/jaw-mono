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
  // Each case uses its own chain id: the hook caches per chain and key.
  it('renders the icon a keyed caller gets back', async () => {
    capabilitiesMock.mockResolvedValue({ '0x1': { chainMetadata: { icon: ICON } } } as never);
    await mount(1, 'test-key');

    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });

  // Keys extracts the key from the rpc url, so a keyless dApp arrives as ''.
  it.each([undefined, ''])('fetches and renders with no key (%o)', async (apiKey) => {
    const chainId = apiKey === undefined ? 10 : 137;
    capabilitiesMock.mockResolvedValue({
      [`0x${chainId.toString(16)}`]: { chainMetadata: { icon: ICON } },
    } as never);
    await mount(chainId, apiKey);

    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(capabilitiesMock.mock.calls[0][1]).toBe(apiKey);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ICON);
  });

  it('does not fetch without a chain', async () => {
    await mount(0, 'test-key');

    expect(capabilitiesMock).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
  });
});
