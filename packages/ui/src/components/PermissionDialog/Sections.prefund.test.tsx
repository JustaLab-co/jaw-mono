import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SpenderPrefundNotice } from './Sections';
import { describeSpenderPrefund } from '../../hooks/useSpenderPrefund';

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const SPENDER = '0x2222222222222222222222222222222222222222' as const;

/**
 * A grant that asks for a prefund moves tokens to an address the requester chose, the moment it
 * lands, and revoking the permission does not bring them back. None of that was on the screen.
 */
describe('the grant screen states the transfer to the spender', () => {
  const markup = (props: Parameters<typeof SpenderPrefundNotice>[0]) =>
    renderToStaticMarkup(<SpenderPrefundNotice {...props} />);

  it('names the amount, the token and where it goes', () => {
    const html = markup({ prefund: { kind: 'transfer', amount: '0.0188', symbol: 'USDC' }, spenderLabel: 'agent.eth' });

    expect(html).toContain('Sent now');
    expect(html).toContain('0.0188 USDC → agent.eth');
  });

  it('says that revoking does not return it', () => {
    const html = markup({ prefund: { kind: 'transfer', amount: '0.0188', symbol: 'USDC' }, spenderLabel: 'agent.eth' });

    expect(html).toContain('It leaves your account immediately');
    expect(html).toContain('revoking the permission doesn&#x27;t return it');
  });

  it('names the decline a person can act on, by granting more', () => {
    const html = markup({
      prefund: { kind: 'below-one-operation', operationCost: '6', symbol: 'USDC' },
      spenderLabel: 'agent.eth',
    });

    expect(html).toContain('won&#x27;t be funded');
    expect(html).toContain('below one transaction&#x27;s fee (6 USDC)');
    expect(html).not.toContain('Sent now');
  });

  it('holds the section open while the transfer is being sized', () => {
    expect(markup({ prefund: null, spenderLabel: 'agent.eth', isLoading: true })).toContain('Sent now');
  });

  it('renders nothing when there is no prefund', () => {
    expect(markup({ prefund: null, spenderLabel: 'agent.eth' })).toBe('');
  });
});

describe('describeSpenderPrefund', () => {
  it('scales the transfer by the token decimals', () => {
    expect(
      describeSpenderPrefund(
        { kind: 'transfer', token: TOKEN, spender: SPENDER, amount: 18_800n },
        {
          decimals: 6,
          symbol: 'USDC',
        }
      )
    ).toEqual({ kind: 'transfer', amount: '0.0188', symbol: 'USDC' });
  });

  // Scaled by a guessed 18, a 6-decimal amount would read a trillion times smaller.
  it('says base units when the decimals could not be read', () => {
    expect(
      describeSpenderPrefund(
        { kind: 'transfer', token: TOKEN, spender: SPENDER, amount: 18_800n },
        {
          decimals: null,
          symbol: '',
        }
      )
    ).toEqual({ kind: 'transfer', amount: '18800', symbol: 'base units' });
    expect(describeSpenderPrefund({ kind: 'transfer', token: TOKEN, spender: SPENDER, amount: 18_800n })).toEqual({
      kind: 'transfer',
      amount: '18800',
      symbol: 'base units',
    });
  });

  it('carries the cost of one operation for the decline', () => {
    expect(
      describeSpenderPrefund(
        { kind: 'below-one-operation', token: TOKEN, allowance: 1_000_000n, operationCost: 6_000_000n },
        { decimals: 6, symbol: 'USDC' }
      )
    ).toEqual({ kind: 'below-one-operation', operationCost: '6', symbol: 'USDC' });
  });

  it('is nothing without a quote', () => {
    expect(describeSpenderPrefund(null)).toBeNull();
  });
});
