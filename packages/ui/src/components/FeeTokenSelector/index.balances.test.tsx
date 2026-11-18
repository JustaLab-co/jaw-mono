// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { FeeTokenSelector, type FeeTokenOption } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix's popper measures its content; jsdom has no ResizeObserver.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
  );
});

const ETH_PRICE = 3000;

const eth: FeeTokenOption = {
  uid: 'eth',
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  balance: 10n ** 17n,
  balanceFormatted: '0.1',
  isNative: true,
  isSelectable: true,
};

// Both ERC-20s carry a paymaster rate, so a dollar balance could be worked out for them.
const usdc: FeeTokenOption = {
  uid: 'usdc',
  symbol: 'USDC',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  balance: 1_260_000n,
  balanceFormatted: '1.26',
  isNative: false,
  isSelectable: true,
  gasCostFormatted: '0.0067',
  gasCostMaxFormatted: '0.0208',
  gasCost: 6_700n,
  gasCostMax: 20_800n,
  exchangeRate: 3000n * 10n ** 6n,
};

// A tokenized stock held in a small amount: 0.00200146 AMZN.
const amzn: FeeTokenOption = {
  uid: 'amzn',
  symbol: 'AMZN',
  address: '0xb20000000000000000000000000000000000a3a2',
  decimals: 18,
  balance: 2_001_460_000_000_000n,
  balanceFormatted: '0.00200146',
  isNative: false,
  isSelectable: true,
  gasCostFormatted: '0.0000',
  gasCostMaxFormatted: '0.0001',
  gasCost: 30_000_000_000_000n,
  gasCostMax: 90_000_000_000_000n,
  exchangeRate: 15n * 10n ** 18n,
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

/** Renders the picker and opens it, as an owner clicking the fee token button would. */
function openPicker(tokens: FeeTokenOption[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <FeeTokenSelector
        tokens={tokens}
        selectedToken={tokens[0]}
        onSelect={() => undefined}
        isLoading={false}
        nativeTokenPrice={ETH_PRICE}
        chainId={8453}
      />
    )
  );
  const trigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]');
  expect(trigger).not.toBeNull();
  act(() => trigger!.click());
}

/** The "Bal: …" line of each row, in list order. */
function balanceLines(): string[] {
  return Array.from(document.querySelectorAll('div'))
    .filter((el) => el.children.length <= 1 && el.textContent?.startsWith('Bal:'))
    .map((el) => el.textContent!.replace(/\s+/g, ' ').trim());
}

describe('FeeTokenSelector balances', () => {
  it('shows ERC-20 balances in the token, and the native balance in dollars', () => {
    openPicker([eth, usdc, amzn]);

    expect(balanceLines()).toEqual(['Bal: $300.0000', 'Bal: 1.26 USDC', 'Bal: 0.002001 AMZN']);
  });

  it('never shows a small stablecoin balance as 0', () => {
    // 0.0042 USDC: under a cent, which two decimals would round to "0".
    openPicker([eth, { ...usdc, balance: 4_200n, balanceFormatted: '0.0042' }]);

    expect(balanceLines()).toEqual(['Bal: $300.0000', 'Bal: 0.0042 USDC']);
  });
});
