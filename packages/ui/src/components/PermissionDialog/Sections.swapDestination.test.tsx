import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SwapDestinationNotice } from './Sections';

const BASE_WETH = '0x4200000000000000000000000000000000000006';
const UNPINNED = '0x9999999999999999999999999999999999999999';

/**
 * A swap permission lets the spender buy one token only. The request names it, and the owner
 * approved the limit without ever seeing which token that was.
 */
describe('the grant screen names the token swaps may buy', () => {
  const markup = (props: Parameters<typeof SwapDestinationNotice>[0]) =>
    renderToStaticMarkup(<SwapDestinationNotice {...props} />);

  it('names a pinned token by its pinned symbol, with its short address and chain', () => {
    const html = markup({
      address: BASE_WETH,
      chainId: 8453,
      chainName: 'Base',
      tokenMeta: { [BASE_WETH]: { symbol: 'FAKE' } },
    });

    expect(html).toContain('Swaps only into WETH (0x4200...0006, Base)');
    expect(html).not.toContain('Unverified');
  });

  it('marks a token outside the pinned table as unverified, named by what it reports', () => {
    const html = markup({
      address: UNPINNED,
      chainId: 8453,
      chainName: 'Base',
      tokenMeta: { [UNPINNED.toUpperCase().replace('0X', '0x')]: { symbol: 'PEPE' } },
    });

    expect(html).toContain('Swaps only into PEPE (0x9999...9999, Base)');
    expect(html).toContain('Unverified token');
  });

  it('falls back to the address when the token has no readable name', () => {
    const html = markup({ address: UNPINNED, chainId: 8453, chainName: 'Base', tokenMeta: {} });

    expect(html).toContain('Swaps only into 0x9999...9999 (Base)');
    expect(html).toContain('its name could not be read');
  });

  it('says the limit is not onchain', () => {
    const html = markup({ address: BASE_WETH, chainId: 8453, chainName: 'Base' });

    expect(html).toContain('enforces this, not the chain');
  });
});
