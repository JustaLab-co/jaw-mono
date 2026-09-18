// @vitest-environment jsdom
// The whole-stack sibling of useChainIconURI. Its `!apiKey` gate was structural,
// since the cache was keyed on the key as well, so keyless it asked for nothing
// and every chain in the stack rendered its fallback glyph.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', () => ({ handleGetCapabilitiesRequest: vi.fn() }));

import { handleGetCapabilitiesRequest } from '@jaw.id/core';
import { clearChainIconsCache, useChainIcons } from './useChainIcons';

const capabilitiesMock = vi.mocked(handleGetCapabilitiesRequest);
const CAPS = { '0x1': { chainMetadata: { icon: 'ICON1' } }, '0xa': { chainMetadata: { icon: 'ICON10' } } };

function Probe({ apiKey }: { apiKey?: string }) {
  const icons = useChainIcons(apiKey);
  return createElement('span', null, JSON.stringify(icons));
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(apiKey?: string) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe, { apiKey }));
  });
  await act(() => Promise.resolve());
}

beforeEach(() => {
  clearChainIconsCache();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.clearAllMocks();
});

describe('useChainIcons', () => {
  // Keys hands this `''` and the SDK hands it undefined, and both are the same
  // caller: the proxy answers them on the origin it was told.
  it.each([undefined, ''])('asks and renders with no key (%o)', async (apiKey) => {
    capabilitiesMock.mockResolvedValue(CAPS as never);

    await mount(apiKey);

    expect(capabilitiesMock).toHaveBeenCalledTimes(1);
    expect(capabilitiesMock.mock.calls[0][1]).toBe(apiKey);
    expect(container.textContent).toBe(JSON.stringify({ 1: 'ICON1', 10: 'ICON10' }));
  });

  it('serves the cached map whichever way the missing key is spelled', async () => {
    capabilitiesMock.mockResolvedValue(CAPS as never);
    await mount('');
    if (root) act(() => root.unmount());
    capabilitiesMock.mockClear();

    await mount(undefined);

    expect(capabilitiesMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('ICON1');
  });
});
