// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { NetworkFeeRow, type NetworkFeeRowProps } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Partial<NetworkFeeRowProps> = {}) => (
  <NetworkFeeRow
    blockReason="estimation-failed"
    nativeSymbol="ETH"
    nativeTokenPrice={0}
    hasSelectablePaymentOption={false}
    {...over}
  />
);

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});

function mount(over: Partial<NetworkFeeRowProps>) {
  const el = document.createElement('div');
  root = createRoot(el);
  act(() => root!.render(row(over)));
  return el;
}

describe('NetworkFeeRow estimation-failed', () => {
  it('names the failure and never offers to add funds', () => {
    const html = renderToStaticMarkup(row({ onRetryEstimation: () => undefined }));
    expect(html).toContain('Fee estimation failed');
    expect(html).not.toMatch(/insufficient/i);
  });

  it('re-runs the estimation from Retry', () => {
    const onRetryEstimation = vi.fn();
    const el = mount({ onRetryEstimation });
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.click());
    expect(onRetryEstimation).toHaveBeenCalledTimes(1);
  });

  it('holds Retry while the transaction is processing', () => {
    const onRetryEstimation = vi.fn();
    const el = mount({ onRetryEstimation, disabled: true });
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    expect(retry.disabled).toBe(true);
    act(() => retry.click());
    expect(onRetryEstimation).not.toHaveBeenCalled();
  });

  it.each([
    ['the fee-token costs are being estimated', { estimatingTokenCosts: true }],
    ['the fee is being estimated', { gasFeeLoading: true, isPayingWithErc20: true }],
  ])('holds Retry while %s', (_label, over) => {
    const onRetryEstimation = vi.fn();
    const el = mount({ onRetryEstimation, ...over });
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    expect(retry.disabled).toBe(true);
    act(() => retry.click());
    expect(onRetryEstimation).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Fee estimation failed');
  });

  /** A retry whose estimation run ends when the test says so. */
  function pendingRetry() {
    let finish!: () => void;
    const onRetryEstimation = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    return { onRetryEstimation, finish: () => act(async () => finish()) };
  }

  const click = (el: HTMLElement, label: string) =>
    act(() => [...el.querySelectorAll('button')].find((b) => b.textContent === label)!.click());

  it('holds Retry while a retry the user started re-estimates the fee in ETH', () => {
    const { onRetryEstimation } = pendingRetry();
    const el = mount({ onRetryEstimation });
    click(el, 'Retry');
    act(() => root!.render(row({ onRetryEstimation, gasFeeLoading: true })));
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retrying…')!;
    expect(retry.disabled).toBe(true);
    act(() => retry.click());
    expect(onRetryEstimation).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Fee estimation failed');
  });

  it('shows Estimating... for an ETH re-estimate the user did not start', () => {
    const el = mount({ onRetryEstimation: vi.fn(), gasFeeLoading: true });
    expect(el.textContent).toContain('Estimating...');
    expect(el.textContent).not.toContain('Retrying…');
    expect(el.textContent).not.toContain('Fee estimation failed');
  });

  it('shows Estimating... for a later ETH re-estimate once a user retry settles', async () => {
    const { onRetryEstimation, finish } = pendingRetry();
    const el = mount({ onRetryEstimation });
    click(el, 'Retry');
    act(() => root!.render(row({ onRetryEstimation, gasFeeLoading: true })));
    await finish();
    act(() => root!.render(row({ onRetryEstimation })));
    act(() => root!.render(row({ onRetryEstimation, gasFeeLoading: true })));
    expect(el.textContent).toContain('Estimating...');
    expect(el.textContent).not.toContain('Retrying…');
  });

  it('does not keep Retrying… after a retry that ran nothing', async () => {
    const { onRetryEstimation, finish } = pendingRetry();
    const el = mount({ onRetryEstimation });
    click(el, 'Retry');
    expect(el.textContent).toContain('Retrying…');
    await finish();
    act(() => root!.render(row({ onRetryEstimation, estimatingTokenCosts: true })));
    expect(el.textContent).not.toContain('Retrying…');
  });
});
