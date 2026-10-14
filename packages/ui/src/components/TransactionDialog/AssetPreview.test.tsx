import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AssetPreview } from './AssetPreview';
import type { AssetDelta } from '../../utils/assetPreview';

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
