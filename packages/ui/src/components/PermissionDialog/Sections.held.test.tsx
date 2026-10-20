import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { HeldGrantsNotice } from './Sections';
import type { HeldGrantsDisplay } from './types';

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

const markup = (held?: HeldGrantsDisplay) =>
  renderToStaticMarkup(<HeldGrantsNotice held={held} chainId={84532} nativeSymbol="ETH" />);

describe('the grant screen shows what the spender already holds', () => {
  it('given live grants, then states their count and the total per token and period', () => {
    const html = markup({
      status: 'ready',
      count: 2,
      totals: [{ amount: '2', token: 'USDC', tokenAddress: USDC, duration: '1 day', limit: '2 USDC' }],
    });

    expect(html).toContain('Already granted to this key');
    expect(html).toMatch(/>2<\/span>/);
    expect(html).toContain('USDC');
    expect(html).toContain('/day');
    expect(html).toContain('This request adds to it');
  });

  it('given grants with no spend limit, then still counts them', () => {
    const html = markup({ status: 'ready', count: 1, totals: [] });

    expect(html).toContain('Already granted to this key');
    expect(html).toContain('No spend limits');
  });

  it('given nothing live, then renders nothing', () => {
    expect(markup({ status: 'ready', count: 0, totals: [] })).toBe('');
    expect(markup(undefined)).toBe('');
  });

  it('given the lookup failed, then says the total is unknown, never zero', () => {
    const html = markup({ status: 'unreadable' });

    expect(html).toContain('Couldn&#x27;t check what this key already holds');
    expect(html).toContain('its total is unknown');
    expect(html).not.toMatch(/>0</);
  });

  it('given the lookup is running, then holds the section open', () => {
    expect(markup({ status: 'loading' })).toContain('Already granted to this key');
  });
});
