import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AllowedCalls, CallRow } from './Sections';
import type { CallPermission } from './types';

const TARGET = '0x3333333333333333333333333333333333333333';
const CHECKER = '0x8888888888888888888888888888888888888888';
const ZERO = '0x0000000000000000000000000000000000000000';

const truncate = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const transfer = (checker?: string): CallPermission => ({
  target: TARGET,
  selector: '0xa9059cbb',
  functionSignature: 'transfer(address,uint256)',
  checker,
});

/**
 * A checker is part of the permission the user signs: the manager asks it to approve every
 * matching call. The SDK knows nothing about what a given checker enforces, so the screen names
 * the contract and says the rule is unverified, rather than leaving it out.
 */
describe('a call checker on the grant screen', () => {
  const row = (call: CallPermission) =>
    renderToStaticMarkup(
      <ul>
        <CallRow call={call} truncateAddress={truncate} />
      </ul>
    );

  it('names the contract that enforces the extra rule, and says it is unverified', () => {
    const html = row(transfer(CHECKER));

    expect(html).toContain('transfer(address,uint256)');
    expect(html).toContain('Extra rule enforced by');
    expect(html).toContain('0x8888…8888');
    expect(html).toContain('Unverified rule');
  });

  it('still shows the rule on an any-function call, where it guards every call to the contract', () => {
    const html = row({ ...transfer(CHECKER), selector: '0x32323232', functionSignature: '' });

    expect(html).toContain('Any function');
    expect(html).toContain('Extra rule enforced by');
  });

  it.each([undefined, ZERO])('shows no rule when the checker is %s', (checker) => {
    expect(row(transfer(checker))).not.toContain('Extra rule');
  });

  it('counts the extra rules on the collapsed card, so they show before anything is opened', () => {
    const html = renderToStaticMarkup(
      <AllowedCalls calls={[transfer(CHECKER), transfer()]} identityOf={() => undefined} truncateAddress={truncate} />
    );

    expect(html).toContain('1 extra rule');
  });

  it('says nothing about rules on a collapsed card without any', () => {
    const html = renderToStaticMarkup(
      <AllowedCalls calls={[transfer(), transfer(ZERO)]} identityOf={() => undefined} truncateAddress={truncate} />
    );

    expect(html).not.toContain('extra rule');
  });
});
