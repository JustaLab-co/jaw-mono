// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Address } from 'viem';
import type { TransactionCall } from '@jaw.id/core';

const simulate = vi.fn();
vi.mock('../utils/assetPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/assetPreview')>()),
  simulateAssetChanges: (...args: unknown[]) => simulate(...args),
}));

import { SimulationRefusedError } from '../utils/assetPreview';
import { useAssetPreview, type UseAssetPreviewConfig, type UseAssetPreviewResult } from './useAssetPreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const callTo = (to: string): TransactionCall => ({ to: to as Address, data: '0x' });
const CALLS = [callTo('0x2222222222222222222222222222222222222222')];
const OTHER_CALLS = [callTo('0x3333333333333333333333333333333333333333')];
const DELTA = { direction: 'out' as const, symbol: 'USDC' };
const NEW_DELTA = { direction: 'in' as const, symbol: 'DAI' };
const OK = { deltas: [DELTA], willRevert: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let latest: UseAssetPreviewResult | null = null;

function Probe(props: UseAssetPreviewConfig) {
  latest = useAssetPreview(props);
  return null;
}

const props = (calls: TransactionCall[] = CALLS): UseAssetPreviewConfig => ({ account: ACCOUNT, calls, chainId: 8453 });

async function render(config: UseAssetPreviewConfig) {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root!.render(createElement(Probe, config)));
  return (next: UseAssetPreviewConfig) => act(async () => root!.render(createElement(Probe, next)));
}

const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  simulate.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAssetPreview retry', () => {
  it('never exposes an error when a retry succeeds', async () => {
    simulate.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(OK);
    await render(props());

    expect(latest?.error).toBe(false);
    await advance(3_000);

    expect(simulate).toHaveBeenCalledTimes(2);
    expect(latest?.error).toBe(false);
    expect(latest?.assetsOut).toEqual([DELTA]);
  });

  it('turns error on only after the third rejection', async () => {
    simulate.mockRejectedValue(new Error('timeout'));
    await render(props());
    await advance(3_000);
    expect(latest?.error).toBe(false);
    await advance(10_000);

    expect(simulate).toHaveBeenCalledTimes(3);
    expect(latest?.error).toBe(true);
    await advance(60_000);
    expect(simulate).toHaveBeenCalledTimes(3);
  });

  it('warns with the error on each rejection', async () => {
    const failure = new Error('timeout');
    simulate.mockRejectedValue(failure);
    await render(props());
    await advance(13_000);

    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(console.warn).mock.calls[0]).toContain(failure);
  });

  it('starts over with a fresh count when the calls change during a retry wait', async () => {
    simulate.mockRejectedValue(new Error('timeout'));
    const rerender = await render(props());
    expect(simulate).toHaveBeenCalledTimes(1);

    await rerender(props(OTHER_CALLS));
    expect(simulate).toHaveBeenCalledTimes(2);
    await advance(3_000);
    expect(simulate).toHaveBeenCalledTimes(3);
    await advance(10_000);
    expect(simulate).toHaveBeenCalledTimes(4);
    expect(latest?.error).toBe(true);
    await advance(60_000);
    expect(simulate).toHaveBeenCalledTimes(4);
  });

  it('runs no simulation after unmount', async () => {
    simulate.mockRejectedValue(new Error('timeout'));
    await render(props());
    act(() => root?.unmount());
    root = null;
    await advance(60_000);

    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('does not retry a simulation that reverts', async () => {
    simulate.mockResolvedValue({ deltas: [], willRevert: true, revertCause: 'other' });
    await render(props());
    await advance(60_000);

    expect(simulate).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ error: false, willRevert: true });
  });

  it('does not retry when the node refuses the batch', async () => {
    simulate.mockRejectedValue(new SimulationRefusedError());
    await render(props());

    expect(latest?.error).toBe(true);
    await advance(60_000);
    expect(simulate).toHaveBeenCalledTimes(1);
  });
});

describe('useAssetPreview when the inputs change', () => {
  it('ignores a late result from the previous calls', async () => {
    const stale = deferred<typeof OK>();
    simulate.mockReturnValueOnce(stale.promise).mockResolvedValue({ deltas: [NEW_DELTA], willRevert: false });
    const rerender = await render(props());
    await rerender(props(OTHER_CALLS));
    expect(latest?.assetsIn).toEqual([NEW_DELTA]);

    await act(async () => stale.resolve(OK));

    expect(latest?.assetsOut).toEqual([]);
    expect(latest?.assetsIn).toEqual([NEW_DELTA]);
  });

  it('ignores a late rejection from the previous calls', async () => {
    const stale = deferred<typeof OK>();
    simulate.mockReturnValueOnce(stale.promise).mockResolvedValue(OK);
    const rerender = await render(props());
    await rerender(props(OTHER_CALLS));

    await act(async () => stale.reject(new Error('timeout')));
    await advance(60_000);

    expect(console.warn).not.toHaveBeenCalled();
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ error: false, assetsOut: [DELTA] });
  });

  it('clears the error', async () => {
    simulate.mockRejectedValue(new Error('timeout'));
    const rerender = await render(props());
    await advance(13_000);
    expect(latest?.error).toBe(true);

    const pending = deferred<typeof OK>();
    simulate.mockReturnValue(pending.promise);
    await rerender(props(OTHER_CALLS));

    expect(latest?.error).toBe(false);
  });

  it('drops the previous deltas while the new calls are simulated and retried', async () => {
    simulate.mockResolvedValueOnce(OK).mockRejectedValueOnce(new Error('timeout'));
    const rerender = await render(props());
    expect(latest?.assetsOut).toEqual([DELTA]);

    await rerender(props(OTHER_CALLS));
    expect(latest?.assetsOut).toEqual([]);

    simulate.mockResolvedValue({ deltas: [NEW_DELTA], willRevert: false });
    await advance(3_000);
    expect(latest).toMatchObject({ assetsOut: [], assetsIn: [NEW_DELTA] });
  });
});
