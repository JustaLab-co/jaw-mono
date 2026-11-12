import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AllowedCalls } from './Sections';
import type { CallPermission, CheckerView } from './types';

const TARGET = '0x3333333333333333333333333333333333333333';
const CHECKER = '0x8888888888888888888888888888888888888888';
const ZERO = '0x0000000000000000000000000000000000000000';

const truncate = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const transfer = (checker?: string, target = TARGET): CallPermission => ({
  target,
  selector: '0xa9059cbb',
  functionSignature: 'transfer(address,uint256)',
  checker,
});

const card = (calls: CallPermission[], checkerNameOf?: (address: string) => string | undefined) =>
  renderToStaticMarkup(
    <AllowedCalls calls={calls} identityOf={() => undefined} truncateAddress={truncate} checkerNameOf={checkerNameOf} />
  );

/**
 * A checker is part of the permission the user signs: the manager asks it to approve every call
 * to the function it sits on. So it is shown under that function, and the card opens on its own
 * whenever a call has one, so nothing the user signs is behind a click.
 */
describe('a call checker in the allowed calls card', () => {
  it('opens to the checked function and names the checker under it', () => {
    const html = card([transfer(CHECKER)]);

    expect(html).toContain('transfer(address,uint256)');
    expect(html).toContain('Checked by');
    expect(html).toContain('0x8888…8888');
  });

  it('shows a name the checker is known by next to its address', () => {
    const html = card([transfer(CHECKER)], (address) => (address === CHECKER ? 'Recipient Guard' : undefined));

    expect(html).toContain('Recipient Guard');
    expect(html).toContain('0x8888…8888');
  });

  it('names the checker under each function it sits on, and only those', () => {
    const approve = { ...transfer(), selector: '0x095ea7b3', functionSignature: 'approve(address,uint256)' };
    const html = card([transfer(CHECKER), approve]);

    expect(html.split('Checked by').length - 1).toBe(1);
  });

  // The signer refuses a grant like this before the screen opens; the screen must not crash on one.
  it('draws nothing for a checker that is not a string', () => {
    expect(() => card([{ ...transfer(), checker: 42 as unknown as string }])).not.toThrow();
    expect(card([{ ...transfer(), checker: 42 as unknown as string }])).not.toContain('Checked by');
  });

  // The explanation of what a checker can do is behind the info icon, so a keyboard or screen
  // reader has to be able to reach it: a bare svg takes no focus.
  it('puts the checker explanation on a button a keyboard can reach', () => {
    const html = card([transfer(CHECKER)]);

    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="Before each call to this function/);
  });

  it('reads as a safeguard, not a warning', () => {
    expect(card([transfer(CHECKER)])).not.toContain('text-warning');
  });

  it.each([undefined, ZERO])('stays collapsed and says nothing about checks when the checker is %s', (checker) => {
    const html = card([transfer(checker)]);

    expect(html).not.toContain('Checked by');
    expect(html).not.toContain('transfer(address,uint256)');
  });
});

/**
 * A reusable checker of ours says exactly what it enforces, so the screen states the rule instead of
 * an address. Anything it can't read is shown as a custom check, in amber, and never blocked.
 */
describe('the rule a call checker enforces', () => {
  const LANDLORD = '0x0000000000000000000000000000000000001a4d';
  const ruleCard = (view: CheckerView | undefined) =>
    renderToStaticMarkup(
      <AllowedCalls
        calls={[transfer(CHECKER)]}
        identityOf={() => undefined}
        truncateAddress={truncate}
        checkerRuleOf={() => view}
      />
    );

  it('states our rule in words, in place of the checker address', () => {
    const html = ruleCard({ tone: 'rule', parts: ['To must be ', { address: LANDLORD }] });

    expect(html).toContain('To must be ');
    expect(html).toContain('0x0000…1a4d');
    expect(html).not.toContain('Checked by');
    expect(html).not.toContain('text-warning');
  });

  it('reads the granting wallet as this wallet', () => {
    expect(ruleCard({ tone: 'rule', parts: ['Recipient must be ', { wallet: true }] })).toContain(
      'Recipient must be <span class="text-foreground font-medium">this wallet</span>'
    );
  });

  it('keeps the checker address one copy away under our rule', () => {
    expect(ruleCard({ tone: 'rule', parts: ['To must be ', { address: LANDLORD }] })).toContain('Copy checker address');
  });

  it('marks a checker it can’t read as a custom check, in amber, with its address', () => {
    const html = ruleCard({ tone: 'custom' });

    expect(html).toContain('Custom check');
    expect(html).toContain('0x8888…8888');
    expect(html).toContain('text-warning');
    expect(html).toMatch(/aria-label="JAW can&#x27;t read what this contract allows/);
  });

  it('warns that a rule which can never pass blocks every call to the function', () => {
    const html = ruleCard({ tone: 'blocks' });

    expect(html).toContain('Blocks every call to this function');
    expect(html).toContain('text-warning');
  });

  it('shows the checker address while its rule is still being read', () => {
    const html = ruleCard(undefined);

    expect(html).toContain('Checked by');
    expect(html).toContain('0x8888…8888');
  });
});
