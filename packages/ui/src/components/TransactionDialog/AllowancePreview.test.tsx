// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { maxUint256 } from 'viem';

import { AllowancePreview } from './AllowancePreview';
import { formatAddress } from '../../utils/formatAddress';
import type { AllowanceChange } from '../../utils/allowances';
import type { AssetDelta } from '../../utils/assetPreview';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';

// Max uint256 needs no token read, so these render in one pass.
const change = (over: Partial<AllowanceChange> = {}): AllowanceChange => ({
  token: TOKEN,
  spender: SPENDER,
  amount: maxUint256,
  added: false,
  allTokens: false,
  unlimited: true,
  revoke: false,
  ambiguous: true,
  ...over,
});

const usdc: AssetDelta = {
  address: TOKEN.toLowerCase(),
  symbol: 'USDC',
  decimals: 6,
  diff: -1n,
  direction: 'out',
  amountFormatted: '1',
  isNative: false,
};

const render = (changes: AllowanceChange[], knownTokens: AssetDelta[] = [], chainId?: number) =>
  renderToStaticMarkup(<AllowancePreview changes={changes} knownTokens={knownTokens} chainId={chainId} />);

/** Class list and visible text of the first row's amount span. */
function amount(html: string) {
  const match = /<span class="(text-value[^"]*)">(.*?)<\/span>/s.exec(html);
  if (!match) throw new Error('no amount span');
  return { className: match[1], text: match[2].replace(/<[^>]+>/g, '') };
}

describe('AllowancePreview', () => {
  it('renders nothing without changes', () => {
    expect(render([])).toBe('');
  });

  it('shows an unlimited approval with the warning on the card and on the amount', () => {
    const html = render([change()]);
    expect(html).toContain('Token approvals');
    expect(html).toContain('border-warning/60');
    expect(html).toMatch(/<svg[^>]*size-3 flex-none[^>]*>/);
    expect(amount(html).text).toBe('Unlimited');
    expect(amount(html).className).toContain('text-warning');
    expect(html).toMatch(/<span class="text-value[^"]*"><svg[^>]*size-3\.5/);
  });

  it('shows all tokens, not unlimited, for a collection-wide approval', () => {
    const html = render([change({ allTokens: true, amount: undefined, ambiguous: false })]);
    expect(amount(html).text).toBe('All tokens');
    expect(amount(html).className).toContain('text-warning');
    expect(html).not.toContain('Unlimited');
  });

  it('shows the spender in the To row and not the token address', () => {
    const html = render([change()], [usdc]);
    expect(html).toContain('>To<');
    expect(html).toContain(formatAddress(SPENDER));
    expect(html).not.toContain(formatAddress(TOKEN));
    expect(html).toContain('USDC');
  });

  it('does not take a symbol from a native delta', () => {
    const native: AssetDelta = { ...usdc, isNative: true };
    expect(render([change()], [native])).toContain(formatAddress(TOKEN));
  });

  it('falls back to the token address when its symbol is unknown', () => {
    expect(render([change()])).toContain(formatAddress(TOKEN));
  });

  it('flags a signed permit and names its owner', () => {
    const html = render([change({ owner: OWNER, ambiguous: false })], [usdc]);
    expect(html).toContain('Permit signed by');
    expect(html).toContain(formatAddress(OWNER));
    expect(html).toMatch(/text-warning[^>]*>[^<]*Permit signed by/);
  });

  it('renders one row per change', () => {
    const html = render([change(), change({ spender: OWNER })]);
    expect(html.match(/Copy spender address/g)).toHaveLength(2);
  });

  it('looks the token icon up on the chain of the request', () => {
    expect(render([change()], [], 8453)).toContain(`/tokens/8453/${TOKEN.toLowerCase()}/icon`);
    expect(render([change()])).not.toContain('<img');
  });

  it('copies the spender address, not the token', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<AllowancePreview changes={[change()]} knownTokens={[]} />));

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy spender address"]')!.click());

    expect(writeText).toHaveBeenCalledWith(SPENDER);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
});
