// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AllowancePreview } from './AllowancePreview';
import { formatAddress } from '../../utils/formatAddress';
import type { AllowanceChange } from '../../utils/allowances';
import type { AssetDelta } from '../../utils/assetPreview';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';

const change = (over: Partial<AllowanceChange> = {}): AllowanceChange => ({
  token: TOKEN,
  spender: SPENDER,
  amount: 5_000_000n,
  added: false,
  allTokens: false,
  unlimited: false,
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

/** The warning style lives in class names, so every assertion on it goes through these two. */
const cardWarns = (html: string) => html.includes('border-warning/60');
const unreadWarns = (html: string) => /<span class="text-warning[^"]*">.*Allowance call could not be read/s.test(html);
const amountWarns = (html: string) => amount(html).className.includes('text-warning');

describe('AllowancePreview', () => {
  it('renders nothing without changes', () => {
    expect(render([])).toBe('');
  });

  it('shows an unlimited approval with the warning on the card and on the amount', () => {
    const html = render([change({ unlimited: true })]);
    expect(html).toContain('Permissions granted');
    expect(cardWarns(html)).toBe(true);
    expect(amount(html).text).toBe('Unlimited');
    expect(amountWarns(html)).toBe(true);
  });

  it('puts a warning icon on the card header and on the amount only when unlimited', () => {
    const warned = render([change({ unlimited: true })]);
    expect(warned).toMatch(/<svg[^>]*size-3 flex-none[^>]*>/);
    expect(warned).toMatch(/<span class="text-value[^"]*"><svg[^>]*size-3\.5/);

    const plain = render([change()]);
    expect(plain).not.toContain('lucide-triangle-alert');
  });

  it('shows all tokens, not unlimited, for a collection-wide approval', () => {
    const html = render([change({ allTokens: true, unlimited: true, amount: undefined })]);
    expect(amount(html).text).toBe('All tokens');
    expect(amountWarns(html)).toBe(true);
    expect(html).not.toContain('Unlimited');
  });

  it('labels a zero approval Revoke only for a token known to be an ERC-20', () => {
    const zero = change({ revoke: true, amount: 0n });
    const known = render([zero], [usdc]);
    expect(amount(known).text).toBe('Revoke');
    expect(known).toContain('Spender');
    expect(cardWarns(known)).toBe(false);
    expect(amountWarns(known)).toBe(false);

    const unknown = render([zero]);
    expect(unknown).not.toContain('Revoke');
    expect(amount(unknown).text).toBe('0 (raw)');
  });

  it('labels a zero Permit2 approval Revoke even when the token is not in the simulation', () => {
    const html = render([change({ revoke: true, amount: 0n, ambiguous: false })]);
    expect(amount(html).text).toBe('Revoke');
  });

  it('does not take a symbol or decimals from a native delta', () => {
    const native: AssetDelta = { ...usdc, isNative: true, symbol: undefined };
    expect(amount(render([change()], [native])).text).toBe('5000000 (raw)');
  });

  it('applies the decimals of a known token, matched in any address case', () => {
    const html = render([change()], [usdc]);
    expect(amount(html).text).toBe('5');
    expect(html).toContain('USDC');
  });

  it('prefixes an increase with a plus sign', () => {
    expect(amount(render([change({ added: true })], [usdc])).text).toBe('+5');
    expect(amount(render([change({ added: true })])).text).toBe('+5000000 (raw)');
  });

  it('says a raw amount is in base units when decimals are unknown', () => {
    const html = render([change()]);
    expect(amount(html).text).toBe('5000000 (raw)');
    expect(amountWarns(html)).toBe(false);
    expect(cardWarns(html)).toBe(false);
  });

  it('shows the spender in the To row and not the token address', () => {
    const html = render([change()], [usdc]);
    expect(html).toContain('>To<');
    expect(html).toContain(formatAddress(SPENDER));
    expect(html).not.toContain(formatAddress(TOKEN));
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

  it('warns that an allowance call could not be read, without a spender', () => {
    const html = render([change({ undecoded: true, spender: '', amount: undefined })]);
    expect(html).toContain('Allowance call could not be read');
    expect(html).toContain(formatAddress(TOKEN));
    expect(html).not.toContain('Copy spender address');
    expect(html).not.toContain('>To<');
    expect(cardWarns(html)).toBe(true);
    expect(unreadWarns(html)).toBe(true);
  });

  it('renders one row per change', () => {
    const html = render([change(), change({ spender: OWNER })]);
    expect(html.match(/Copy spender address/g)).toHaveLength(2);
  });

  it('reads a change without an amount as a raw zero', () => {
    expect(amount(render([change({ amount: undefined })])).text).toBe('0 (raw)');
  });

  it('flags the card when any one change is unlimited, not only when all are', () => {
    expect(cardWarns(render([change({ unlimited: true }), change()]))).toBe(true);
    expect(cardWarns(render([change(), change()]))).toBe(false);
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
