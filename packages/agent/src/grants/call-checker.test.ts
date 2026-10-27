import { describe, it, expect } from 'vitest';
import {
  callRuleKey,
  checkerOf,
  hasChecker,
  isCheckerAddress,
  isRefusedChecker,
  PERMISSIONS_MANAGER,
} from './call-checker.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHECKER = '0x398b9d939E7E616E03eA99601c835C920621B2ca';
const ZERO = '0x0000000000000000000000000000000000000000';
const ACCOUNT = '0x6270F137994f9169106250b4480EEEEe40fB3847';

// A record or a wallet from before checkers names none, and every such permission was approved
// with the zero checker, so absent and zero have to read as the same rule everywhere.
describe('the zero checker', () => {
  it('reads an absent checker as zero, and either as no checker', () => {
    expect(checkerOf({})).toBe(ZERO);
    expect(hasChecker({})).toBe(false);
    expect(hasChecker({ checker: ZERO })).toBe(false);
    expect(hasChecker({ checker: CHECKER })).toBe(true);
  });

  it('keys an absent checker and the zero one as one rule, and another checker as another', () => {
    const rule = { target: USDC, selector: '0xa9059cbb' };

    expect(callRuleKey(rule)).toBe(callRuleKey({ ...rule, checker: ZERO }));
    expect(callRuleKey(rule)).not.toBe(callRuleKey({ ...rule, checker: CHECKER }));
    expect(callRuleKey({ ...rule, checker: CHECKER })).toBe(callRuleKey({ ...rule, checker: CHECKER.toLowerCase() }));
  });
});

describe('a checker the manager refuses', () => {
  it('refuses the manager in any case, and the account only when it is known', () => {
    expect(isRefusedChecker(PERMISSIONS_MANAGER.toLowerCase())).toBe(true);
    expect(isRefusedChecker(ACCOUNT)).toBe(false);
    expect(isRefusedChecker(ACCOUNT.toLowerCase(), ACCOUNT)).toBe(true);
    expect(isRefusedChecker(CHECKER, ACCOUNT)).toBe(false);
  });

  it('takes only a 20-byte address as a checker', () => {
    expect(isCheckerAddress(CHECKER)).toBe(true);
    expect(isCheckerAddress('0x1234')).toBe(false);
    expect(isCheckerAddress(42)).toBe(false);
  });
});
