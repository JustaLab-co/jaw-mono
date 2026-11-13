import { describe, expect, it } from 'vitest';
import { formatEther, maxUint160, maxUint256 } from 'viem';
import {
  dateTone,
  formatNativeValue,
  formatUnixDate,
  groupNumber,
  isUnixTimestamp,
  isUnlimitedAmount,
  maxUintFor,
  subscriptDecimal,
  formatSpendAmount,
  isLongSpendAmount,
  isStartField,
} from './displayFormat';

describe('subscriptDecimal', () => {
  it('renders leading-zero-count subscript notation for tiny values', () => {
    expect(subscriptDecimal(0.000002732)).toBe('0.0₅2732'); // 5 leading zeros
    expect(subscriptDecimal(0.00003456)).toBe('0.0₄3456');
    expect(subscriptDecimal(0.00005)).toBe('0.0₄5');
    expect(subscriptDecimal(9e-8)).toBe('0.0₇9');
  });
  it('caps significant digits via `sig`', () => {
    expect(subscriptDecimal(0.000012345678, 3)).toBe('0.0₄123');
  });
  it('returns "0" for non-positive / non-finite input', () => {
    expect(subscriptDecimal(0)).toBe('0');
    expect(subscriptDecimal(-1)).toBe('0');
    expect(subscriptDecimal(NaN)).toBe('0');
  });
});

describe('groupNumber', () => {
  it('thousands-separates integers and preserves fractions/sign', () => {
    expect(groupNumber('1000000')).toBe('1,000,000');
    expect(groupNumber('1000.5')).toBe('1,000.5');
    expect(groupNumber('-1234567')).toBe('-1,234,567');
    expect(groupNumber('999')).toBe('999');
  });
});

describe('maxUintFor', () => {
  it('computes the max for a uint width, null for non-uint types', () => {
    expect(maxUintFor('uint256')).toBe(maxUint256);
    expect(maxUintFor('uint160')).toBe(maxUint160);
    expect(maxUintFor('uint48')).toBe(281474976710655n);
    expect(maxUintFor('address')).toBeNull();
  });
});

describe('isUnlimitedAmount', () => {
  it('flags the uint256 / uint160 max sentinels', () => {
    expect(isUnlimitedAmount(maxUint256.toString())).toBe(true);
    expect(isUnlimitedAmount(maxUint160.toString())).toBe(true);
    // Permit2 unlimited amount literal (uint160 max):
    expect(isUnlimitedAmount('1461501637330902918203684832716283019655932542975')).toBe(true);
  });
  it('does not flag ordinary amounts or empty input', () => {
    expect(isUnlimitedAmount('500000000000000000')).toBe(false);
    expect(isUnlimitedAmount(undefined)).toBe(false);
    expect(isUnlimitedAmount('')).toBe(false);
  });
});

describe('isUnixTimestamp', () => {
  it('accepts values in the 2000..2100 window, rejects tiny/huge', () => {
    expect(isUnixTimestamp(1753358400n)).toBe(true);
    expect(isUnixTimestamp(100n)).toBe(false);
    expect(isUnixTimestamp(281474976710655n)).toBe(false); // uint48 max — a sentinel, not a date
  });
});

describe('formatUnixDate', () => {
  it('renders day-first abbreviated dates', () => {
    const s = formatUnixDate(1753358400); // 2025-07-24T12:00:00Z (noon → TZ-stable day)
    expect(s).toContain('24');
    expect(s).toContain('Jul');
    expect(s).toContain('2025');
  });
});

describe('formatNativeValue', () => {
  // The regression this exists for: a length-based wei-vs-ether guess rendered
  // short decimal wei strings verbatim, so 1 gwei displayed as "1000000000 ETH"
  // — 10^18x the amount actually signed. Every row below is a decimal wei string
  // that the old heuristic passed through untouched.
  it('reads short decimal strings as wei, not ether', () => {
    expect(formatNativeValue('1000000000')).toBe('0.000000001');
    expect(formatNativeValue('5000')).toBe('0.000000000000005');
    expect(formatNativeValue('1')).toBe('0.000000000000000001');
    expect(formatNativeValue('999999999')).toBe('0.000000000999999999');
  });

  it('reads long decimal strings as wei', () => {
    expect(formatNativeValue('1000000000000000000')).toBe('1');
    expect(formatNativeValue('10000000000')).toBe('0.00000001');
    expect(formatNativeValue('1100000000000000000')).toBe('1.1');
  });

  it('reads hex quantities as wei', () => {
    expect(formatNativeValue('0xde0b6b3a7640000')).toBe('1'); // 1 ETH
    expect(formatNativeValue('0x3b9aca00')).toBe('0.000000001'); // 1 gwei
  });

  it('agrees with the value fed to BigInt when the call is built', () => {
    // Display and signed intent must derive from the same parse.
    for (const raw of ['1', '5000', '1000000000', '1000000000000000000', '0xde0b6b3a7640000']) {
      expect(formatNativeValue(raw)).toBe(formatEther(BigInt(raw)));
    }
  });

  it('returns null for absent or zero values so the row can be omitted', () => {
    expect(formatNativeValue(undefined)).toBeNull();
    expect(formatNativeValue('')).toBeNull();
    expect(formatNativeValue('0')).toBeNull();
    expect(formatNativeValue('0x0')).toBeNull();
    expect(formatNativeValue('0x00')).toBeNull(); // missed by the old === '0x0' check
    expect(formatNativeValue('0000')).toBeNull(); // missed by the old === '0' check
  });

  it('returns null rather than a wrong number for unparseable input', () => {
    // "1.0" is not a valid wei quantity; building the call throws on it too.
    expect(formatNativeValue('1.0')).toBeNull();
    expect(formatNativeValue('0.5')).toBeNull();
    expect(formatNativeValue('abc')).toBeNull();
    expect(formatNativeValue('0xzz')).toBeNull();
    expect(formatNativeValue('-1')).toBeNull();
  });
});

describe('dateTone', () => {
  const now = Math.floor(Date.now() / 1000);
  it('classifies past as expired', () => {
    expect(dateTone(now - 100)).toBe('expired');
    expect(dateTone('1000000000')).toBe('expired'); // 2001
  });
  it('classifies >1yr out as far', () => {
    expect(dateTone(now + 60 * 60 * 24 * 400)).toBe('far');
  });
  it('classifies near-future as normal', () => {
    expect(dateTone(now + 60 * 60 * 24 * 30)).toBe('normal');
  });
  it('never classifies a start in the past as expired: a signature valid since then can still be used', () => {
    expect(dateTone(now - 2 * 24 * 60 * 60, 'start')).toBe('normal');
    expect(dateTone('1000000000', 'start')).toBe('normal'); // 2001
  });
  it('still classifies a start more than a year out as far', () => {
    expect(dateTone(now + 60 * 60 * 24 * 400, 'start')).toBe('far');
  });
});

describe('isStartField', () => {
  it('recognizes the fields a signature starts being valid at, by name or path', () => {
    for (const name of ['validAfter', 'notBefore', 'validFrom', 'startTime', 'valid_after', 'details.validAfter']) {
      expect(isStartField(name), name).toBe(true);
    }
  });
  it('leaves deadlines and other timestamps out', () => {
    for (const name of ['validBefore', 'validUntil', 'notAfter', 'deadline', 'expiry', 'timestamp', 'startTimeout']) {
      expect(isStartField(name), name).toBe(false);
    }
  });
});

describe('formatSpendAmount', () => {
  it('scales by the token decimals', () => {
    expect(formatSpendAmount(100_000_000n, 6)).toEqual({ amount: '100', decimalsUnknown: false });
  });

  it('handles a zero-decimals token', () => {
    expect(formatSpendAmount(42n, 0)).toEqual({ amount: '42', decimalsUnknown: false });
  });

  // The regression this exists for: 100 USDC assumed to be 18dp reads as 0.0000000001 — a 10^12
  // understatement of what the spender may take.
  it('reports raw base units rather than assuming 18 when decimals are unknown', () => {
    expect(formatSpendAmount(100_000_000n, null)).toEqual({
      amount: '100000000',
      decimalsUnknown: true,
    });
    expect(formatSpendAmount(100_000_000n, 18).amount).toBe('0.0000000001');
  });

  it('treats undefined the same as null', () => {
    expect(formatSpendAmount(5n, undefined)).toEqual({ amount: '5', decimalsUnknown: true });
  });

  it('does not lose precision on a max-uint allowance', () => {
    const max = 2n ** 256n - 1n;
    expect(formatSpendAmount(max, null).amount).toBe(max.toString());
  });

  it('keeps zero readable in both modes', () => {
    expect(formatSpendAmount(0n, 6)).toEqual({ amount: '0', decimalsUnknown: false });
    expect(formatSpendAmount(0n, null)).toEqual({ amount: '0', decimalsUnknown: true });
  });
});

describe('isLongSpendAmount', () => {
  it('keeps an ordinary scaled amount inline', () => {
    expect(isLongSpendAmount('100')).toBe(false);
    expect(isLongSpendAmount('1234.5678')).toBe(false);
  });

  it('keeps a mid-size base-units figure inline', () => {
    // 100 USDC unscaled — 9 digits, still fits beside the token symbol.
    expect(isLongSpendAmount('100000000')).toBe(false);
  });

  it('breaks at the boundary', () => {
    expect(isLongSpendAmount('1'.repeat(12))).toBe(false);
    expect(isLongSpendAmount('1'.repeat(13))).toBe(true);
  });

  it('moves an unscaled max-uint allowance to its own line', () => {
    // The case that broke the layout: 78 digits with nowhere to wrap.
    const raw = formatSpendAmount(2n ** 256n - 1n, null).amount;
    expect(raw).toHaveLength(78);
    expect(isLongSpendAmount(raw)).toBe(true);
  });
});
