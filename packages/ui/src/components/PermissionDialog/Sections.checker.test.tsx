import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AllowedCalls, CallChecks } from './Sections';
import type { CallPermission } from './types';
import type { AddressIdentity } from '../../hooks/useAddressIdentities';

const TARGET = '0x3333333333333333333333333333333333333333';
const CHECKER = '0x8888888888888888888888888888888888888888';
const OTHER_CHECKER = '0x9999999999999999999999999999999999999999';
const ZERO = '0x0000000000000000000000000000000000000000';

const truncate = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const transfer = (checker?: string): CallPermission => ({
  target: TARGET,
  selector: '0xa9059cbb',
  functionSignature: 'transfer(address,uint256)',
  checker,
});
const approve = (checker?: string): CallPermission => ({
  ...transfer(checker),
  selector: '0x095ea7b3',
  functionSignature: 'approve(address,uint256)',
});

const unnamed = () => undefined;
const checks = (calls: CallPermission[], identityOf: (address: string) => AddressIdentity | undefined = unnamed) =>
  renderToStaticMarkup(<CallChecks calls={calls} identityOf={identityOf} truncateAddress={truncate} />);

/**
 * A checker is part of the permission the user signs: the manager asks it to approve every
 * matching call. It gets its own section, so it reads on its own: which contract checks, and
 * which calls it checks.
 */
describe('the call checks section of the grant screen', () => {
  it('names the checker contract and the function it checks', () => {
    const html = checks([transfer(CHECKER)]);

    expect(html).toContain('Call checks');
    expect(html).toContain('0x8888…8888');
    expect(html).toContain('transfer(address,uint256)');
  });

  it('shows a name the checker is known by above its address', () => {
    const html = checks([transfer(CHECKER)], (address) =>
      address === CHECKER ? ({ clearSigningName: 'Recipient Guard' } as AddressIdentity) : undefined
    );

    expect(html).toContain('Recipient Guard');
    expect(html).toContain('0x8888…8888');
  });

  it('gives each checker one row, listing every function it checks', () => {
    const html = checks([transfer(CHECKER), approve(CHECKER), transfer(OTHER_CHECKER)]);

    expect(html.split('0x8888…8888').length - 1).toBe(1);
    expect(html).toContain('0x9999…9999');
    expect(html).toContain('approve(address,uint256)');
  });

  it('reads as a safeguard, not a warning', () => {
    expect(checks([transfer(CHECKER)])).not.toContain('text-warning');
  });

  it.each([[[transfer()]], [[transfer(ZERO)]]])('renders nothing for calls without a checker', (calls) => {
    expect(checks(calls)).toBe('');
  });

  it('leaves the checker out of the allowed calls card, so it is said once', () => {
    const html = renderToStaticMarkup(
      <AllowedCalls calls={[transfer(CHECKER)]} identityOf={unnamed} truncateAddress={truncate} />
    );

    expect(html).not.toContain('0x8888…8888');
    expect(html).not.toContain('Extra rule');
  });
});
