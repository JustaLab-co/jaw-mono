import { describe, it, expect } from 'vitest';
import { whyGrantExceedsCeiling } from './grant-ceiling.js';
import { buildX402Permissions } from './grant-preset.js';

/**
 * The flow this guards is an agent hitting a 402, asking for a budget, and a
 * human approving it in the browser. It works today, and only by accident: an
 * agent with shell access picks the `--limit` itself, so the browser screen is
 * the entire check on the number, and screens get clicked through. The ceiling
 * moves the decision to a human at a terminal, once, ahead of time.
 */

const BASE_SEPOLIA = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

describe('whyGrantExceedsCeiling', () => {
  it('allows anything when no ceiling is set, which is every install today', () => {
    expect(whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '9999/day'), BASE_SEPOLIA, undefined)).toBeNull();
  });

  it('allows a grant at the ceiling', () => {
    expect(whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '10/day'), BASE_SEPOLIA, '10/day')).toBeNull();
  });

  it('allows a grant under it', () => {
    expect(whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '5/day'), BASE_SEPOLIA, '10/day')).toBeNull();
  });

  it('refuses a larger allowance', () => {
    const why = whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '25/day'), BASE_SEPOLIA, '10/day');
    expect(why).toMatch(/over the 10\/day ceiling/);
  });

  /**
   * The one that a rate check alone would let through, and the reason the rule
   * bounds both the amount and the period: the same allowance on a shorter
   * period is more money over the same time. `10/hour` under a `10/day` ceiling
   * is twenty-four times the budget.
   */
  it('refuses the same allowance on a shorter period', () => {
    const why = whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '10/hour'), BASE_SEPOLIA, '10/day');
    expect(why).toMatch(/more often than the 10\/day ceiling/);
  });

  it('allows the same allowance on a longer period', () => {
    expect(whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '10/week'), BASE_SEPOLIA, '10/day')).toBeNull();
  });

  // A month is at least 28 days, so it clears a weekly ceiling on the shortest
  // month there is rather than on an average one.
  it('measures a month by its shortest length', () => {
    expect(whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '10/month'), BASE_SEPOLIA, '10/week')).toBeNull();
    expect(whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '10/week'), BASE_SEPOLIA, '10/month')).toMatch(
      /more often than/
    );
  });

  it('allows a one-time allowance over the whole permission', () => {
    expect(whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '10/forever'), BASE_SEPOLIA, '10/day')).toBeNull();
  });

  /**
   * The bypass worth closing: `--limit` is not the only way to name a spend.
   * A hand-written `--permissions` reaches the same grant, so the ceiling is
   * checked against the resolved permission rather than the flag.
   */
  it('bounds a hand-written permission the same way', () => {
    const handWritten = {
      calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
      spends: [{ token: USDC, allowance: '99000000', unit: 'day', multiplier: 1 }],
    };
    expect(whyGrantExceedsCeiling(handWritten, BASE_SEPOLIA, '10/day')).toMatch(/over the 10\/day ceiling/);
  });

  /**
   * A spend the ceiling cannot be measured against is refused rather than waved
   * through: letting it past unmeasured is a way around the ceiling, not an
   * exception to it.
   */
  it('refuses a spend in a token the ceiling cannot price', () => {
    const other = {
      calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
      spends: [{ token: '0x9999999999999999999999999999999999999999', allowance: '1', unit: 'day', multiplier: 1 }],
    };
    expect(whyGrantExceedsCeiling(other, BASE_SEPOLIA, '10/day')).toMatch(/cannot be measured against it/);
  });

  it('refuses every grant while the ceiling itself is unreadable', () => {
    const why = whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, '1/day'), BASE_SEPOLIA, 'ten dollars');
    expect(why).toMatch(/not a valid limit/);
  });

  /**
   * The registry covers four chains. Skipping the check on the rest would leave
   * a ceiling that is true only where someone happened to look, and a grant on
   * any other chain would be the way around it.
   */
  it('refuses a spend on a chain with no registry asset to price against', () => {
    const handWritten = {
      calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
      spends: [{ token: USDC, allowance: '99000000', unit: 'day', multiplier: 1 }],
    };
    expect(whyGrantExceedsCeiling(handWritten, 1, '10/day')).toMatch(/no USDC in the registry/);
  });

  it('allows a calls-only permission there, since it spends nothing', () => {
    const callsOnly = { calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }] };
    expect(whyGrantExceedsCeiling(callsOnly, 1, '10/day')).toBeNull();
  });

  /**
   * A month is measured at its shortest for the grant and at its longest for the
   * ceiling, so without saying it outright 28 days against 31 refused a grant at
   * exactly the ceiling's own period.
   */
  it.each(['month', 'year'] as const)('allows a grant at the ceiling on a %s period', (period) => {
    expect(
      whyGrantExceedsCeiling(buildX402Permissions(BASE_SEPOLIA, `10/${period}`), BASE_SEPOLIA, `10/${period}`)
    ).toBeNull();
  });

  it('says nothing for a calls-only permission, which spends nothing', () => {
    const callsOnly = { calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }] };
    expect(whyGrantExceedsCeiling(callsOnly, BASE_SEPOLIA, '10/day')).toBeNull();
  });
});
