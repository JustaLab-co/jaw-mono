import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SpendLimits } from './Sections';
import type { SpendPermission } from './types';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNKNOWN_TOKEN = '0x1234567890123456789012345678901234567890';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const spend = (overrides: Partial<SpendPermission>): SpendPermission => ({
  amount: '10',
  token: 'USDC',
  tokenAddress: USDC,
  duration: '1 Day',
  limit: '10000000',
  ...overrides,
});

const markup = (spends: SpendPermission[], isLoading = false) =>
  renderToStaticMarkup(<SpendLimits spends={spends} chainId={8453} nativeSymbol="ETH" isLoading={isLoading} />);

/** What a grant lets the spender take, row by row, as the grant screen shows it. */
describe('the spend limits on a grant screen', () => {
  it('shows each limit with its token, amount, rate and price', () => {
    const html = markup([spend({ amountUsd: '10.00' })]);

    expect(html).toContain('Spend limit');
    expect(html).toContain('USDC');
    expect(html).toContain('>10<');
    expect(html).toContain('/day');
    expect(html).toContain('$10.00');
    expect(html).toContain('Copy token address');
  });

  it("names the chain's own coin for a native limit, with no token address to copy", () => {
    const html = markup([spend({ token: '', tokenAddress: NATIVE, amount: '0.5' })]);

    expect(html).toContain('ETH');
    expect(html).not.toContain('Copy token address');
  });

  it('says when the amount is in base units because the token would not give its decimals, and shows no price for it', () => {
    const html = markup([
      spend({
        token: '',
        tokenAddress: UNKNOWN_TOKEN,
        amount: '100000000',
        amountUsd: '100.00',
        decimalsUnknown: true,
      }),
    ]);

    expect(html).toContain('0x1234...7890');
    expect(html).toContain('decimals unknown');
    expect(html).toContain('base units');
    expect(html).not.toContain('$100.00');
  });

  it('keeps every digit of an amount too long to sit beside the token', () => {
    const max = (2n ** 256n - 1n).toString();
    expect(markup([spend({ amount: max })])).toContain(max);
  });

  it('shows no amounts while the tokens are still being looked up', () => {
    const html = markup([spend({ amountUsd: '10.00' })], true);

    expect(html).toContain('Spend limit');
    expect(html).not.toContain('/day');
    expect(html).not.toContain('$10.00');
  });
});
