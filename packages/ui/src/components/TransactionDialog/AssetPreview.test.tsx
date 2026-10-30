// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const prices = vi.hoisted(() => ({ fetch: vi.fn<(symbol: string) => Promise<number>>() }));
vi.mock('../../utils/tokenPrice', () => ({ fetchTokenPrice: prices.fetch }));

import { AssetPreview } from './AssetPreview';
import type { AssetDelta } from '../../utils/assetPreview';
import type { BridgeTransfer } from '../../utils/bridgeCalls/transfer';

const WARNING = 'Could not simulate this transaction';

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

const delta = (over: Partial<AssetDelta> & { symbol: string }): AssetDelta => ({
  address: `0x${over.symbol.charCodeAt(0).toString(16).padStart(40, '0')}`,
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
    await mount({ assetsOut: [usdc], assetsIn: [ethReceived] });
    await settle();
    expect(host.textContent).toContain('$10.00');
    expect(host.textContent!.match(/\$/g)).toHaveLength(1);
  });

  it('a value of exactly one cent is shown, below it reads <$0.01', async () => {
    prices.fetch.mockResolvedValue(2);
    await mount({ assetsOut: [delta({ symbol: 'USDC', amountFormatted: '0.005' })] });
    await settle();
    expect(host.textContent).toContain('$0.01');
    expect(host.textContent).not.toContain('<$0.01');

    await mount({ assetsOut: [delta({ symbol: 'USDC', amountFormatted: '0.004' })] });
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
    await mount({ assetsOut: [usdc] });
    await mount({ assetsOut: [delta({ symbol: 'WETH', amountFormatted: '1' })] });
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

  it('shows the amount in the token units with the unverified tag and the short address', async () => {
    await mount({ bridge: transferTo(read) });
    const text = get(host.textContent!);
    expect(text).toContain('AAPL');
    expect(text).toContain('unverified');
    expect(text).toContain('0xaF3D...93f9');
    expect(text).toContain('≥ 2.5');
    expect(host.textContent).not.toContain('base units');
  });

  it('does not price a token by the symbol it gave itself, and tags a USDC look-alike the same way', async () => {
    prices.fetch.mockResolvedValue(1);
    await mount({ bridge: transferTo({ ...read, symbol: 'USDC', decimals: 6 }) });
    await settle();
    expect(prices.fetch.mock.calls.map((c) => c[0])).toEqual(['USDC']);
    expect(get(host.textContent!)).toContain('unverified');
    expect(get(host.textContent!)).not.toContain('$');
  });

  it('leaves a pinned token without the tag', () => {
    const out = html({ bridge: transferTo({ address: SENT, known: true, symbol: 'USDC', decimals: 6 }) });
    expect(out).not.toContain('unverified');
  });

  it('keeps base units for a token that was not read', () => {
    const out = html({ bridge: transferTo({ address: AAPL, known: false }) });
    expect(get(out)).toContain('2500000000000000000 base units');
    expect(out).not.toContain('unverified');
  });
});
