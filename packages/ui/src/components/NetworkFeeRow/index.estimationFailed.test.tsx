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
    estimationFailureDetail="execution reverted"
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
  });
});
