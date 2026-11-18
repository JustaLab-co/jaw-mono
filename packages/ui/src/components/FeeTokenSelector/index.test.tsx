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

// Both ERC-20s carry paymaster rates, so a dollar balance could be worked out for them.
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
  exchangeRateNativeToUsd: 3000n * 10n ** 6n,
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
  exchangeRateNativeToUsd: 3000n * 10n ** 6n,
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

type Options = {
  nativeTokenPrice?: number;
  estimatedGasEth?: string;
  selectedToken?: FeeTokenOption | null;
  onSelect?: (token: FeeTokenOption) => void;
  /** Mount inside a dialog card, as both hosts do. */
  inDialog?: boolean;
};

function mount(tokens: FeeTokenOption[], options: Options = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const container = options.inDialog ? host.appendChild(document.createElement('div')) : host;
  if (options.inDialog) container.setAttribute('role', 'dialog');
  root = createRoot(container);
  act(() =>
    root!.render(
      <FeeTokenSelector
        tokens={tokens}
        selectedToken={options.selectedToken === undefined ? tokens[0] : options.selectedToken}
        onSelect={options.onSelect ?? (() => undefined)}
        isLoading={false}
        nativeTokenPrice={options.nativeTokenPrice ?? ETH_PRICE}
        estimatedGasEth={options.estimatedGasEth}
        chainId={8453}
      />
    )
  );
  return container;
}

/** Renders the picker and opens it, as an owner clicking the fee token button would. */
function openPicker(tokens: FeeTokenOption[], options: Options = {}) {
  const container = mount(tokens, options);
  const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
  expect(trigger).not.toBeNull();
  act(() => trigger!.click());
  return trigger!;
}

const picker = () => document.querySelector('[data-slot="popover-content"]');

/** Each row of the open list: its symbol, its "Bal: …" line, and what it shows for the fee. */
function rows() {
  return Array.from(picker()?.querySelectorAll<HTMLButtonElement>('.overflow-y-auto > button') ?? []).map((row) => {
    const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const info = row.children[1];
    return {
      symbol: text(info?.children[0]),
      balance: text(info?.children[1]),
      balanceHtml: info?.children[1]?.innerHTML ?? '',
      fee: text(row.lastElementChild),
      feeHtml: row.lastElementChild?.innerHTML ?? '',
      button: row,
    };
  });
}

describe('FeeTokenSelector balances', () => {
  it('shows ERC-20 balances in the token, and the native balance in dollars', () => {
    openPicker([eth, usdc, amzn]);

    expect(rows().map((r) => r.balance)).toEqual(['Bal: $300.0000', 'Bal: 1.26 USDC', 'Bal: 0.002001 AMZN']);
  });

  it('never shows a small stablecoin balance as 0', () => {
    // 0.0042 USDC: under a cent, which two decimals would round to "0".
    openPicker([eth, { ...usdc, balance: 4_200n, balanceFormatted: '0.0042' }]);

    expect(rows().map((r) => r.balance)).toEqual(['Bal: $300.0000', 'Bal: 0.0042 USDC']);
  });

  it('shows dust in subscript rather than as 0', () => {
    openPicker([eth, { ...amzn, balance: 50_000_000_000_000n, balanceFormatted: '0.00005' }]);

    // "0.0₄5": the count of zeros renders as a real subscript.
    expect(rows()[1].balanceHtml).toMatch(/Bal: .*0\.0<sub[^>]*>4<\/sub>5 AMZN/);
  });

  it('shows the native balance in the coin when there is no price for it', () => {
    openPicker([eth, usdc], { nativeTokenPrice: 0 });

    expect(rows()[0].balance).toBe('Bal: 0.1 ETH');
  });
});

describe('FeeTokenSelector fees', () => {
  it('shows the native fee in dollars with its amount as the ceiling', () => {
    openPicker([eth, usdc], { estimatedGasEth: '0.00005' });

    const [native] = rows();
    expect(native.fee).toMatch(/^\$0\.1500Up to /);
    expect(native.feeHtml).toMatch(/Up to .*0\.0<sub[^>]*>4<\/sub>5 ETH/);
  });

  it('shows the native fee in the coin when there is no price for it', () => {
    openPicker([eth, usdc], { estimatedGasEth: '0.0002', nativeTokenPrice: 0 });

    expect(rows()[0].fee).toBe('0.0002 ETH');
  });

  it('shows no native fee before there is an estimate', () => {
    openPicker([eth, usdc], { estimatedGasEth: 'not a number' });

    expect(rows()[0].fee).toBe('');
  });

  it('shows a quoted ERC-20 fee in dollars with its ceiling', () => {
    openPicker([eth, usdc]);

    expect(rows()[1].fee).toBe('$0.0067Up to 0.0208 USDC');
  });

  it('leaves a payable ERC-20 with no estimate yet blank', () => {
    const pending = { ...usdc, gasCostFormatted: undefined, gasCostMaxFormatted: undefined, gasCost: undefined };
    openPicker([eth, pending]);

    expect(rows()[1].fee).toBe('');
  });

  it('marks an empty token as 0 and one that cannot cover the fee as insufficient, and offers neither', () => {
    const empty = { ...amzn, balance: 0n, balanceFormatted: '0', isSelectable: false };
    const short = { ...usdc, gasCostFormatted: 'Insufficient', isSelectable: false };
    openPicker([eth, short, empty]);

    const [, shortRow, emptyRow] = rows();
    expect([shortRow.fee, shortRow.balance]).toEqual(['Insufficient', 'Bal: 1.26 USDC']);
    expect([emptyRow.fee, emptyRow.balance]).toEqual(['0', 'Bal: 0 AMZN']);
    expect(shortRow.button.disabled && emptyRow.button.disabled).toBe(true);
  });
});

describe('FeeTokenSelector picking', () => {
  it('selects the token the owner picks and closes the list', () => {
    const onSelect = vi.fn();
    openPicker([eth, usdc, amzn], { onSelect });

    act(() => rows()[2].button.click());

    expect(onSelect).toHaveBeenCalledWith(amzn);
    expect(picker()).toBeNull();
  });

  it('closes from its close button without changing the selection', () => {
    const onSelect = vi.fn();
    openPicker([eth, usdc], { onSelect });

    act(() => picker()!.querySelector<HTMLButtonElement>('.border-b button')!.click());

    expect(onSelect).not.toHaveBeenCalled();
    expect(picker()).toBeNull();
  });

  it('opens with every token from inside a dialog card', () => {
    openPicker([eth, usdc, amzn], { inDialog: true });

    expect(rows().map((r) => r.symbol)).toEqual(['ETH', 'USDC', 'AMZN']);
  });

  it('asks the owner to select when nothing is selected yet', () => {
    const trigger = openPicker([eth, usdc], { selectedToken: null });

    expect(trigger.textContent).toBe('Select');
  });
});

describe('FeeTokenSelector without a list', () => {
  it('says the options are loading', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<FeeTokenSelector tokens={[]} selectedToken={null} onSelect={() => undefined} isLoading />));

    expect(host.textContent).toBe('Loading payment options...');
  });

  it('shows the native coin as a plain label when no ERC-20 can pay', () => {
    const container = mount([eth]);

    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('ETH');
  });

  it('shows nothing when there is no option at all', () => {
    const container = mount([]);

    expect(container.textContent).toBe('');
  });
});
