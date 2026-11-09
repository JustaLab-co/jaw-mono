// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../utils/assetPreview', () => ({ simulateAssetChanges: vi.fn() }));

import { simulateAssetChanges } from '../utils/assetPreview';
import { useAssetPreview, type UseAssetPreviewResult } from './useAssetPreview';

const simulate = vi.mocked(simulateAssetChanges);
const ACCOUNT = '0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b';
const CALLS = [{ to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', value: 1n }];

let result: UseAssetPreviewResult;
let root: Root | null = null;

function Probe({ account }: { account?: `0x${string}` }) {
  result = useAssetPreview({ account, calls: CALLS, chainId: 8453 });
  return null;
}

async function mount(account?: `0x${string}`) {
  const next = createRoot(document.createElement('div'));
  root = next;
  await act(async () => next.render(createElement(Probe, { account })));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  simulate.mockReset();
});

describe('useAssetPreview simulated', () => {
  it('is set once the simulation answers, whether the calls succeed or revert', async () => {
    simulate.mockResolvedValueOnce({ deltas: [], willRevert: false });
    await mount(ACCOUNT);
    expect(result).toMatchObject({ simulated: true, willRevert: false });

    act(() => root?.unmount());
    simulate.mockResolvedValueOnce({ deltas: [], willRevert: true, revertCause: 'other' });
    await mount(ACCOUNT);
    expect(result).toMatchObject({ simulated: true, willRevert: true });
  });

  it('stays unset while the simulation is in flight', async () => {
    simulate.mockReturnValueOnce(new Promise(() => undefined));
    await mount(ACCOUNT);
    expect(result.simulated).toBe(false);
  });

  it('stays unset when the simulation could not run', async () => {
    simulate.mockRejectedValueOnce(new Error('eth_simulateV1 not supported'));
    await mount(ACCOUNT);
    expect(result).toMatchObject({ simulated: false, error: true });

    act(() => root?.unmount());
    await mount(undefined);
    expect(result.simulated).toBe(false);
  });

  it('is set when the calls ran clean but their amounts could not be read', async () => {
    simulate.mockResolvedValueOnce({ deltas: [], willRevert: false, unreadable: true });
    await mount(ACCOUNT);
    expect(result).toMatchObject({ simulated: true, willRevert: false, error: true });
  });
});

describe('useAssetPreview loading', () => {
  it('is set while the simulation runs and cleared once it answers or fails', async () => {
    simulate.mockReturnValueOnce(new Promise(() => undefined));
    await mount(ACCOUNT);
    expect(result.loading).toBe(true);

    act(() => root?.unmount());
    simulate.mockResolvedValueOnce({ deltas: [], willRevert: false });
    await mount(ACCOUNT);
    expect(result.loading).toBe(false);

    act(() => root?.unmount());
    simulate.mockRejectedValueOnce(new Error('eth_simulateV1 not supported'));
    await mount(ACCOUNT);
    expect(result.loading).toBe(false);

    act(() => root?.unmount());
    await mount(undefined);
    expect(result.loading).toBe(false);
  });
});
