// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const prices = vi.hoisted(() => ({ fetch: vi.fn<(symbol: string) => Promise<number>>() }));
vi.mock('../../utils/tokenPrice', () => ({ fetchTokenPrice: prices.fetch }));

import { AssetPreview } from './AssetPreview';
import { mapAssetChanges, type AssetDelta } from '../../utils/assetPreview';
import type { BridgeTransfer } from '../../utils/bridgeCalls/transfer';
import { snapshotContracts } from '../../utils/bridgeCalls/table';

const WARNING = 'Could not simulate this transaction';

// Rows as the simulation builds them, so the symbol is cleaned the way it is in the app.
const simulatedRows = (address: string, diff: bigint, decimals: number, symbol?: string) =>
  mapAssetChanges([{ token: { address, decimals, symbol }, value: { pre: 0n, post: diff, diff } }]);

const usdcOut: AssetDelta = {
  address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  symbol: 'USDC',
  decimals: 6,
  diff: -5_000_000n,
  direction: 'out',
  amountFormatted: '5',
  isNative: false,
};

const ethIn: AssetDelta = {
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  diff: 10n ** 16n,
  direction: 'in',
  amountFormatted: '0.01',
  isNative: true,
};

const render = (props: { assetsOut?: AssetDelta[]; assetsIn?: AssetDelta[]; error?: boolean }) =>
  renderToStaticMarkup(
    <AssetPreview
      assetsOut={props.assetsOut ?? []}
      assetsIn={props.assetsIn ?? []}
      error={props.error ?? false}
      nativeSymbol="ETH"
    />
  );

describe('AssetPreview', () => {
  it('warns that balance changes are unknown when the simulation failed', () => {
    const html = render({ error: true });
    expect(html).toContain(WARNING);
    expect(html).toContain('review each call before you approve');
  });

  it('renders nothing when the simulation succeeded with no balance changes', () => {
    expect(render({})).toBe('');
  });

  it('labels each side with its own asset and sign', () => {
    const html = render({ assetsOut: [usdcOut], assetsIn: [ethIn] });
    expect(html).not.toContain(WARNING);
    const send = html.indexOf('You send');
    const get = html.indexOf('You get');
    expect(send).toBeGreaterThan(-1);
    expect(get).toBeGreaterThan(send);
    const sendSide = html.slice(send, get);
    const getSide = html.slice(get);
    expect(sendSide).toContain('USDC');
    expect(sendSide).toMatch(/text-negative[^>]*>\u22125</);
    expect(getSide).toContain('ETH');
    expect(getSide).toMatch(/text-positive[^>]*>\+0\.01</);
  });

  it('shows only the side that has changes', () => {
    const out = render({ assetsOut: [usdcOut] });
    expect(out).toContain('You send');
    expect(out).not.toContain('You get');
    const received = render({ assetsIn: [ethIn] });
    expect(received).toContain('You get');
    expect(received).not.toContain('You send');
  });
});

// USDC and WETH sit at their pinned Base addresses, so on Base the generic screen prices them.
const onBase = { chainId: 8453, contracts: snapshotContracts() };
const BASE_PINNED: Record<string, string> = {
  USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  WETH: '0x4200000000000000000000000000000000000006',
};
const delta = (over: Partial<AssetDelta> & { symbol: string }): AssetDelta => ({
  address: BASE_PINNED[over.symbol] ?? `0x${over.symbol.charCodeAt(0).toString(16).padStart(40, '0')}`,
  decimals: 6,
  diff: -1n,
  direction: 'out',
  amountFormatted: '5',
  isNative: false,
  ...over,
});
const usdc = delta({ symbol: 'USDC' });
const dai = delta({ symbol: 'DAI' });
const weth = delta({ symbol: 'WETH' });
const ethReceived = delta({
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  direction: 'in',
  amountFormatted: '0.01',
  isNative: true,
});

type Props = Partial<Parameters<typeof AssetPreview>[0]>;
const props = (p: Props) => ({ assetsOut: [], assetsIn: [], error: false, nativeSymbol: 'ETH', ...p });
const html = (p: Props) => renderToStaticMarkup(<AssetPreview {...props(p)} />);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  prices.fetch.mockReset();
  prices.fetch.mockResolvedValue(0);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const mount = async (p: Props) => {
  await act(async () => root.render(<AssetPreview {...props(p)} />));
};
const settle = () => act(async () => undefined);

describe('AssetPreview rows, prices and tooltips', () => {
  it('under a permission the columns say Sends and Receives, never you', () => {
    const out = html({ assetsOut: [usdc], assetsIn: [ethReceived], onBehalf: true });
    expect(out).toContain('Sends');
    expect(out).toContain('Receives');
    expect(out).not.toContain('You send');
    expect(out).not.toContain('You get');
    expect(out.indexOf('Sends')).toBeLessThan(out.indexOf('Receives'));
  });

  it('a token row carries its address and a copy button, a native row does not', () => {
    const out = html({ assetsOut: [usdc], assetsIn: [ethReceived] });
    const sendSide = out.slice(out.indexOf('You send'), out.indexOf('You get'));
    const getSide = out.slice(out.indexOf('You get'));
    expect(sendSide).toContain('Copy token address');
    expect(getSide).not.toContain('Copy token address');
  });

  it('the copy button copies the token address', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await mount({ assetsOut: [usdc] });

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy token address"]')!.click());

    expect(writeText).toHaveBeenCalledWith(usdc.address);
    vi.unstubAllGlobals();
  });

  it('the token icon is looked up on the chain of the request', () => {
    const out = html({ assetsOut: [usdc], chainId: 8453 });
    expect(out).toContain('/tokens/8453/');
    expect(html({ assetsOut: [usdc] })).not.toContain('<img');
  });

  it('the failure notice is an alert', () => {
    expect(html({ error: true })).toContain('role="alert"');
  });

  it('two rows show, the third collapses behind +1 and expands and collapses again', async () => {
    await mount({ assetsOut: [usdc, dai, weth] });
    const rows = () => ['USDC', 'DAI', 'WETH'].filter((s) => host.textContent!.includes(s));
    const toggle = () => host.querySelector<HTMLButtonElement>('button[type="button"]:not([aria-label])')!;
    expect(rows()).toEqual(['USDC', 'DAI']);
    expect(toggle().textContent).toBe('+1');

    await act(async () => toggle().click());
    expect(rows()).toEqual(['USDC', 'DAI', 'WETH']);
    expect(toggle().textContent).toBe('Show less');

    await act(async () => toggle().click());
    expect(rows()).toEqual(['USDC', 'DAI']);
  });

  it('two rows have no toggle', async () => {
    await mount({ assetsOut: [usdc, dai] });
    expect(host.querySelector('button:not([aria-label])')).toBeNull();
  });

  it('a priced row shows its value in dollars and an unpriced one shows none', async () => {
    prices.fetch.mockImplementation(async (s) => (s === 'USDC' ? 2 : 0));
    await mount({ assetsOut: [usdc], assetsIn: [ethReceived], ...onBase });
    await settle();
    expect(host.textContent).toContain('$10.00');
    expect(host.textContent!.match(/\$/g)).toHaveLength(1);
  });

  it('a value of exactly one cent is shown, below it reads <$0.01', async () => {
    prices.fetch.mockResolvedValue(2);
    await mount({ assetsOut: [delta({ symbol: 'USDC', amountFormatted: '0.005' })], ...onBase });
    await settle();
    expect(host.textContent).toContain('$0.01');
    expect(host.textContent).not.toContain('<$0.01');

    await mount({ assetsOut: [delta({ symbol: 'USDC', amountFormatted: '0.004' })], ...onBase });
    await settle();
    expect(host.textContent).toContain('<$0.01');
  });

  it('every symbol of both columns is priced, and a changed set is priced again', async () => {
    prices.fetch.mockResolvedValue(1);
    await mount({ assetsOut: [usdc, dai], assetsIn: [ethReceived] });
    await settle();
    expect(prices.fetch.mock.calls.map((c) => c[0]).sort()).toEqual(['DAI', 'ETH', 'USDC']);

    await mount({ assetsOut: [weth], assetsIn: [ethReceived] });
    await settle();
    expect(prices.fetch).toHaveBeenCalledWith('WETH');
  });

  it('a price that arrives after the assets changed is dropped', async () => {
    const first = Promise.withResolvers<number>();
    prices.fetch.mockImplementation((s) => (s === 'USDC' ? first.promise : Promise.resolve(3)));
    await mount({ assetsOut: [usdc], ...onBase });
    await mount({ assetsOut: [delta({ symbol: 'WETH', amountFormatted: '1' })], ...onBase });
    await settle();
    expect(host.textContent).toContain('$3.00');

    await act(async () => first.resolve(7));
    expect(host.textContent).toContain('$3.00');
  });

  it('the tooltip of a rounded amount opens above it and gives the full amount with its symbol', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    );
    await mount({ assetsOut: [delta({ symbol: 'USDC', amountFormatted: '1.234567891' })] });
    const trigger = host.querySelector('[data-state="closed"]')!;

    await act(async () => trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));

    const content = document.body.querySelector('[data-side]')!;
    expect(content.getAttribute('data-side')).toBe('top');
    expect(content.textContent).toContain('−1.234567891 USDC');
    vi.unstubAllGlobals();
  });
});

describe('AssetPreview generic screen prices only pinned tokens', () => {
  const UNPRICED = 'Unverified token, so no USD value.';
  const fakeSol = simulatedRows('0x000000000000000000000000000000000000ad01', 10_000_000_000n, 6, 'SOL');

  it('does not price a token at an address outside the table by the symbol it reports, and says so', async () => {
    prices.fetch.mockImplementation(async (s) => (s === 'SOL' ? 150 : 0));
    await mount({ assetsIn: fakeSol, ...onBase });
    await settle();
    expect(host.textContent).toContain('+10000');
    expect(host.textContent).not.toContain('$');
    expect(host.textContent).toContain(UNPRICED);
  });

  it('adds no note to a token outside the table whose symbol has no price either', async () => {
    await mount({ assetsIn: fakeSol, ...onBase });
    await settle();
    expect(host.textContent).not.toContain(UNPRICED);
  });

  it('prices a pinned token by the symbol the table gives it, not the one it reports', async () => {
    prices.fetch.mockImplementation(async (s) => (s === 'USDC' ? 1 : 0));
    await mount({ assetsIn: simulatedRows(BASE_PINNED.USDC, 10_000_000n, 6, 'USDC.e'), ...onBase });
    await settle();
    expect(host.textContent).toContain('$10.00');
    expect(host.textContent).not.toContain(UNPRICED);
  });

  it('prices nothing but the native coin on a chain the table lacks', async () => {
    prices.fetch.mockResolvedValue(2);
    await mount({ assetsOut: [usdc], assetsIn: [ethReceived], chainId: 999_999, contracts: snapshotContracts() });
    await settle();
    expect(host.textContent!.match(/\$/g)).toHaveLength(1);
    expect(host.textContent).toContain('$0.02');
    expect(host.textContent).toContain(UNPRICED);
  });
});

describe('AssetPreview bridge receive side for a token read from the chain', () => {
  const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
  const SENT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const robinhood = { name: 'Robinhood Chain', nativeSymbol: 'ETH' };
  const base = { name: 'Base', nativeSymbol: 'ETH' };
  const transferTo = (token: BridgeTransfer['send']['token']): BridgeTransfer => ({
    provider: 'across',
    title: 'Bridge to Robinhood Chain',
    send: { chainId: 8453, amount: 10_000_000n, token: { address: SENT, known: true, symbol: 'USDC', decimals: 6 } },
    origin: base,
    receive: { kind: 'minimum', amount: { chainId: 4663, amount: 2_500_000_000_000_000_000n, token } },
    destination: robinhood,
    details: [],
  });
  const read: BridgeTransfer['send']['token'] = {
    address: AAPL,
    known: false,
    unverified: true,
    symbol: 'AAPL',
    decimals: 18,
  };
  const get = (text: string) => text.slice(text.indexOf('You get'));

  it('shows the amount in the token units with the symbol untagged and the short address', async () => {
    await mount({ bridge: transferTo(read) });
    const text = get(host.textContent!);
    expect(text).toContain('AAPL');
    expect(text).not.toContain('unverified');
    expect(text).toContain('0xaF3D...93f9');
    expect(text).toContain('≥ 2.5');
    expect(host.textContent).not.toContain('base units');
  });

  it('does not price a token by the symbol it gave itself, so a USDC look-alike shows no dollar value', async () => {
    prices.fetch.mockResolvedValue(1);
    await mount({ bridge: transferTo({ ...read, symbol: 'USDC', decimals: 6 }) });
    await settle();
    expect(prices.fetch.mock.calls.map((c) => c[0])).toEqual(['USDC']);
    expect(get(host.textContent!)).toContain('USDC');
    expect(get(host.textContent!)).not.toContain('$');
  });

  it('keeps base units for a token that was not read', () => {
    const out = html({ bridge: transferTo({ address: AAPL, known: false }) });
    expect(get(out)).toContain('2500000000000000000 base units');
    expect(out).not.toContain('unverified');
  });

  it('says the token could not be read when it is in base units', () => {
    const out = html({ bridge: transferTo({ address: AAPL, known: false }) });
    expect(get(out)).toContain('Could not read this token.');
  });
});

describe('AssetPreview bridge send side when the simulation could not read the token', () => {
  const MKR = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';
  const bridge: BridgeTransfer = {
    provider: 'across',
    title: 'Bridge to Base',
    send: {
      chainId: 1,
      amount: 2_000_000_000_000_000_000n,
      token: { address: MKR, known: true, symbol: 'MKR', decimals: 18 },
    },
    origin: { name: 'Ethereum', nativeSymbol: 'ETH' },
    details: [],
  };
  const simulated: AssetDelta = {
    address: MKR.toLowerCase(),
    decimals: 18,
    diff: -2_000_000_000_000_000_000n,
    direction: 'out',
    amountFormatted: '2',
    isNative: false,
  };

  it.each([
    ['no symbol', undefined],
    ['an empty symbol', ''],
    ['a blank symbol', '   '],
  ])('names a row the simulation left with %s by the symbol the bridge read', (_, symbol) => {
    const assetsOut = simulatedRows(simulated.address, simulated.diff, simulated.decimals, symbol);
    const out = html({ assetsOut, bridge });
    expect(out).toContain('MKR');
  });

  it('does not price a token outside the pinned table by the symbol the simulation read', async () => {
    prices.fetch.mockResolvedValue(1);
    const send = {
      ...bridge.send,
      token: { address: MKR, known: false, unverified: true, symbol: 'WETH', decimals: 18 },
    };
    const assetsOut = simulatedRows(simulated.address, simulated.diff, simulated.decimals, 'WETH');
    await mount({ assetsOut, bridge: { ...bridge, send } });
    await settle();
    expect(host.textContent).toContain('WETH');
    expect(prices.fetch).not.toHaveBeenCalledWith('WETH');
    expect(host.textContent).not.toContain('$');
  });

  it('does not price a sent token the bridge could not read by the symbol the simulation read', async () => {
    prices.fetch.mockResolvedValue(150_000);
    const send = { ...bridge.send, token: { address: MKR, known: false } };
    const assetsOut = simulatedRows(simulated.address, -(10n ** 19n), simulated.decimals, 'SOL');
    await mount({ assetsOut, bridge: { ...bridge, send } });
    await settle();
    expect(host.textContent).toContain('SOL');
    expect(prices.fetch).not.toHaveBeenCalledWith('SOL');
    expect(host.textContent).not.toContain('$');
  });

  it('scales a row the simulation left in base units by the decimals the bridge read', () => {
    const raw = {
      ...simulated,
      symbol: 'MKR',
      decimals: 0,
      amountFormatted: '2000000000000000000',
      baseUnits: true as const,
    };
    const out = html({ assetsOut: [raw], bridge });
    expect(out).not.toContain('base units');
    expect(out).not.toContain('Could not read the decimals.');
  });
});

describe('AssetPreview simulated rows with unusable decimals', () => {
  const raw: AssetDelta = { ...usdcOut, decimals: 0, amountFormatted: '1234567', baseUnits: true };

  it('shows the amount in base units, right after it, with the note', async () => {
    await mount({ assetsOut: [raw] });
    expect(host.textContent).toContain('\u22121234567 base units');
    expect(host.textContent).toContain('Could not read the decimals.');
    expect(host.textContent).not.toContain('In base units');
  });

  it('asks for no price for a base units row', async () => {
    prices.fetch.mockResolvedValue(1);
    await mount({ assetsOut: [raw] });
    await settle();
    expect(prices.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['no symbol', undefined],
    ['an empty symbol', ''],
    ['a blank symbol', '   '],
    ['a symbol with a zero-width space', 'USDC\u{200b}'],
  ])('labels a token with %s by its short address and asks for no price', async (_, symbol) => {
    prices.fetch.mockResolvedValue(1);
    await mount({ assetsOut: simulatedRows(usdcOut.address, usdcOut.diff, usdcOut.decimals, symbol) });
    await settle();
    expect(host.textContent).toContain('You send');
    expect(host.querySelector('.text-symbol')?.textContent).toBe('0x036c...cf7e');
    expect(prices.fetch).not.toHaveBeenCalled();
  });

  it('shows no dollar value for a pinned token whose amount is in base units', async () => {
    prices.fetch.mockResolvedValue(1);
    await mount({ assetsIn: [{ ...raw, direction: 'in', amountFormatted: '5000000' }] });
    await settle();
    expect(host.textContent).toContain('5000000 base units');
    expect(host.textContent).not.toContain('$');
  });
});

describe('AssetPreview bridge views and the simulated receive side', () => {
  const USDC = usdcOut.address as `0x${string}`;
  const NOTE = 'Simulated, not guaranteed.';
  const base = { name: 'Base', nativeSymbol: 'ETH' };
  const send = {
    chainId: 8453,
    amount: 5_000_000n,
    token: { address: USDC, known: true, symbol: 'USDC', decimals: 6 },
  };
  const sameChainSwap: BridgeTransfer = {
    provider: 'relay',
    title: 'Swap through Relay',
    send,
    origin: base,
    sameChain: true,
    details: [],
  };
  const ethSwap: BridgeTransfer = {
    ...sameChainSwap,
    send: {
      chainId: 8453,
      amount: 10n ** 16n,
      token: { address: '0x0000000000000000000000000000000000000000', known: true, symbol: 'ETH', decimals: 18 },
    },
  };
  const ethOut: AssetDelta = { ...ethIn, diff: -(10n ** 16n), direction: 'out' };
  const unorderedDeposit: BridgeTransfer = {
    provider: 'relay',
    title: 'Deposit to Relay',
    send,
    origin: base,
    details: [],
  };
  const checked = (provider: BridgeTransfer['provider']): BridgeTransfer => ({
    provider,
    title: 'Bridge to Arbitrum',
    send,
    origin: base,
    receive: {
      kind: 'minimum',
      amount: {
        chainId: 42161,
        amount: 4_900_000n,
        token: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', known: true, symbol: 'USDC', decimals: 6 },
      },
    },
    destination: { name: 'Arbitrum', nativeSymbol: 'ETH' },
    details: [],
  });
  const getSide = (text: string) => text.slice(text.indexOf('You get'));

  it('a same-chain swap with no checked receive shows the simulated amount, marked as not guaranteed', async () => {
    await mount({ assetsOut: [usdcOut], assetsIn: [ethIn], bridge: sameChainSwap });
    const side = getSide(host.textContent!);
    expect(side).toContain(NOTE);
    expect(side).toContain('+0.01');
    expect(host.textContent).not.toContain('≥');
  });

  it('a same-chain swap prices the simulated native row like the generic screen does', async () => {
    prices.fetch.mockResolvedValue(2000);
    await mount({ assetsOut: [usdcOut], assetsIn: [ethIn], bridge: sameChainSwap });
    await settle();
    expect(prices.fetch.mock.calls.map((c) => c[0]).sort()).toEqual(['ETH', 'USDC']);
    expect(host.textContent).toContain('$20.00');
  });

  it('a same-chain swap does not price a simulated token by the symbol it reports', async () => {
    prices.fetch.mockResolvedValue(1);
    const fakeUsdcIn: AssetDelta = {
      ...usdcOut,
      address: '0x2222222222222222222222222222222222222222',
      diff: 5_000_000n,
      direction: 'in',
    };
    await mount({ assetsOut: [usdcOut], assetsIn: [fakeUsdcIn], bridge: sameChainSwap });
    await settle();
    const side = getSide(host.textContent!);
    expect(side).toContain('+5');
    expect(side).not.toContain('$');
  });

  it('a same-chain swap under a permission says Receives, never you', () => {
    const out = html({ assetsOut: [usdcOut], assetsIn: [ethIn], bridge: sameChainSwap, onBehalf: true });
    expect(out).toContain('Receives');
    expect(out).toContain(NOTE);
    expect(out).not.toContain('You get');
  });

  it('a same-chain swap shows no receive side when the simulation failed', () => {
    const out = html({ assetsIn: [ethIn], bridge: sameChainSwap, error: true, simulated: true });
    expect(out).not.toContain('You get');
    expect(out).not.toContain(NOTE);
  });

  it('a same-chain swap the simulation sees pay nothing back says nothing arrives', () => {
    const out = html({ assetsOut: [usdcOut], bridge: sameChainSwap, simulated: true });
    expect(getSide(out)).toContain('The simulation sees no verified asset arriving.');
    expect(out).not.toContain(NOTE);
  });

  it('a same-chain swap that pays out only a token at an unpinned address says no verified asset arrives', () => {
    const fakeUsdcIn = {
      ...usdcOut,
      address: '0x2222222222222222222222222222222222222222',
      diff: 10_000_000n,
      direction: 'in' as const,
      amountFormatted: '10',
    };
    const out = html({
      assetsOut: [usdcOut],
      assetsIn: [fakeUsdcIn],
      bridge: sameChainSwap,
      simulated: true,
      ...onBase,
    });
    expect(getSide(out)).toContain('+10');
    expect(getSide(out)).toContain('The simulation sees no verified asset arriving.');
    expect(out).not.toContain(NOTE);
  });

  it('a same-chain swap that pays out only native dust says no verified asset arrives', () => {
    const dust = { ...ethIn, diff: 1n, amountFormatted: '0.000000000000000001' };
    const out = html({ assetsOut: [usdcOut], assetsIn: [dust], bridge: sameChainSwap, simulated: true });
    expect(getSide(out)).toContain('The simulation sees no verified asset arriving.');
    expect(out).not.toContain(NOTE);
  });

  it.each([
    ['1 base unit', 1n, false],
    ['99 base units, just under a ten-thousandth', 99n, false],
    ['100 base units, a ten-thousandth', 100n, true],
    ['101 base units, just over a ten-thousandth', 101n, true],
  ])('a same-chain swap that pays out %s of pinned USDC', (_, diff, paysOut) => {
    const usdcIn = { ...usdcOut, address: BASE_PINNED.USDC, diff, direction: 'in' as const };
    const out = html({ assetsOut: [ethOut], assetsIn: [usdcIn], bridge: ethSwap, simulated: true, ...onBase });
    expect(getSide(out).includes('The simulation sees no verified asset arriving.')).toBe(!paysOut);
    expect(out.includes(NOTE)).toBe(paysOut);
  });

  it('a same-chain swap that pays out a pinned token shows it priced, marked as not guaranteed', async () => {
    prices.fetch.mockImplementation(async (s) => (s === 'USDC' ? 1 : 0));
    const usdcIn = {
      ...usdcOut,
      address: BASE_PINNED.USDC,
      diff: 10_000_000n,
      direction: 'in' as const,
      amountFormatted: '10',
    };
    await mount({ assetsOut: [ethOut], assetsIn: [usdcIn], bridge: ethSwap, simulated: true, ...onBase });
    await settle();
    const side = getSide(host.textContent!);
    expect(side).toContain(NOTE);
    expect(side).toContain('$10.00');
    expect(side).not.toContain('The simulation sees no verified asset arriving.');
  });

  it('a same-chain swap the simulation sees revert says nothing about what arrives', () => {
    const out = html({ assetsOut: [usdcOut], bridge: sameChainSwap, simulated: true, willRevert: true });
    expect(out).not.toContain('The simulation sees no verified asset arriving.');
  });

  it('a bridge view does not price another token the simulation sees leave by the symbol it reports', async () => {
    prices.fetch.mockImplementation(async (s) => ({ USDC: 1, SOL: 150 })[s] ?? 0);
    const fakeSolOut = {
      ...usdcOut,
      address: '0x000000000000000000000000000000000000ad01',
      symbol: 'SOL',
      diff: -10_000_000_000n,
      amountFormatted: '10000',
    };
    await mount({
      assetsOut: [usdcOut, fakeSolOut],
      assetsIn: [ethIn],
      bridge: sameChainSwap,
      simulated: true,
      ...onBase,
    });
    await settle();
    expect(host.textContent).toContain('−10000');
    expect(host.textContent).toContain('$5.00');
    expect(host.textContent).not.toContain('$1,500,000.00');
  });

  it('a same-chain swap says nothing about what arrives before the simulation answers', () => {
    expect(html({ assetsOut: [usdcOut], bridge: sameChainSwap })).not.toContain('You get');
  });

  it('a deposit that crosses chains never says nothing arrives, since the simulation cannot see the other chain', () => {
    const out = html({ assetsOut: [usdcOut], bridge: unorderedDeposit, simulated: true });
    expect(out).not.toContain('You get');
  });

  it('a Relay deposit with no order, which may cross chains, still drops the simulated receive', () => {
    const out = html({ assetsOut: [usdcOut], assetsIn: [ethIn], bridge: unorderedDeposit });
    expect(out).toContain('You send');
    expect(out).not.toContain('You get');
    expect(out).not.toContain(NOTE);
  });

  it.each(['across', 'relay'] as const)(
    'a checked %s bridge shows its minimum and not the simulated amount',
    async (provider) => {
      await mount({ assetsOut: [usdcOut], assetsIn: [ethIn], bridge: checked(provider) });
      const side = getSide(host.textContent!);
      expect(side).toContain('≥ 4.9');
      expect(side).not.toContain('0.01');
      expect(host.textContent).not.toContain(NOTE);
    }
  );
});
