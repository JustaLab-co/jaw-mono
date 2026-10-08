import { describe, it, expect } from 'vitest';
import { buildX402Permissions, parseLimit, describeX402Grant, DEFAULT_X402_LIMIT } from './grant-preset.js';
import { parsePermissionsConfig } from './permissions-config.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

describe('parseLimit', () => {
  it('reads amount and period', () => {
    expect(parseLimit('25/day')).toEqual({ amount: '25', period: 'day' });
    expect(parseLimit('2.5/week')).toEqual({ amount: '2.5', period: 'week' });
  });

  it('defaults a bare amount to per day', () => {
    expect(parseLimit('10')).toEqual({ amount: '10', period: 'day' });
  });

  it('tolerates surrounding whitespace and period casing', () => {
    expect(parseLimit('  10 / Day ')).toEqual({ amount: '10', period: 'day' });
  });

  it('rejects a bad period with the list of valid ones', () => {
    expect(() => parseLimit('10/fortnight')).toThrow(/Expected one of/);
  });

  it('rejects amounts that are not plain positive numbers', () => {
    for (const bad of ['-5/day', '1e6/day', 'abc/day', '/day']) {
      expect(() => parseLimit(bad)).toThrow(/Invalid limit amount|Expected a positive number/);
    }
  });

  it('rejects an empty limit', () => {
    expect(() => parseLimit('   ')).toThrow(/empty/);
  });

  it('rejects extra segments', () => {
    expect(() => parseLimit('10/day/week')).toThrow(/Expected <amount>\/<period>/);
  });
});

describe('buildX402Permissions', () => {
  it('grants a USDC transfer capped per period, without the user naming either', () => {
    const permissions = buildX402Permissions(8453, '25/day');
    expect(permissions.calls).toEqual([{ target: USDC_BASE, functionSignature: 'transfer(address,uint256)' }]);
    expect(permissions.spends).toEqual([{ token: USDC_BASE, allowance: '25000000', unit: 'day', multiplier: 1 }]);
  });

  it('resolves the right USDC per chain', () => {
    expect(buildX402Permissions(84532).spends?.[0].token).toBe(USDC_BASE_SEPOLIA);
    expect(buildX402Permissions(8453).spends?.[0].token).toBe(USDC_BASE);
  });

  it('scales fractional amounts by the token decimals', () => {
    expect(buildX402Permissions(8453, '2.5/day').spends?.[0].allowance).toBe('2500000');
    expect(buildX402Permissions(8453, '0.001/day').spends?.[0].allowance).toBe('1000');
  });

  it('defaults to the documented limit', () => {
    expect(buildX402Permissions(8453)).toEqual(buildX402Permissions(8453, DEFAULT_X402_LIMIT));
    expect(buildX402Permissions(8453).spends?.[0].allowance).toBe('10000000'); // 10 USDC
  });

  // The whole point is that the output is accepted downstream without the user
  // having to know the shape, so hold the two in lockstep.
  it('produces something the grant validator accepts', () => {
    expect(() => parsePermissionsConfig(buildX402Permissions(8453, '25/day'))).not.toThrow();
    expect(() => parsePermissionsConfig(buildX402Permissions(84532))).not.toThrow();
  });

  it('names the supported chains when there is no USDC for this one', () => {
    expect(() => buildX402Permissions(1)).toThrow(/No USDC configured for chain 1.*supported on/s);
  });

  // SpendLimit.allowance is uint160 on chain; past that the grant dies in ABI
  // encoding with an opaque range error instead of naming the number typed.
  it('refuses a limit larger than a uint160 allowance can hold', () => {
    expect(() => buildX402Permissions(8453, `${'9'.repeat(45)}/day`)).toThrow(/larger than a spend allowance can hold/);
  });

  it('accepts a limit just inside the uint160 bound', () => {
    const max = (2n ** 160n - 1n) / 10n ** 6n;
    expect(() => buildX402Permissions(8453, `${max}/day`)).not.toThrow();
  });

  it('refuses a limit that rounds to zero rather than granting an unusable permission', () => {
    // Below one base unit at 6 decimals.
    expect(() => buildX402Permissions(8453, '0.0000001/day')).toThrow(/resolves to zero/);
  });
});

describe('describeX402Grant', () => {
  it('summarises the grant in words', () => {
    expect(describeX402Grant('25/day')).toBe('25 USDC per day, transfers only');
    expect(describeX402Grant('100/forever')).toBe('100 USDC in total, transfers only');
    expect(describeX402Grant()).toBe('10 USDC per day, transfers only');
  });
});
