import { describe, it, expect } from 'vitest';
import { spendExposure } from './spendExposure';

const NOW = 1_760_000_000;
const days = (n: number) => NOW + n * 86_400;

describe('spendExposure', () => {
  it('multiplies the allowance by the windows the permission lives through', () => {
    expect(spendExposure({ allowance: 10_000_000n, unit: 'day', multiplier: 1, expiry: days(30), now: NOW })).toEqual({
      periods: 30,
      total: 300_000_000n,
    });
  });

  it('counts a partly used window as a whole one', () => {
    // 30 days and an hour still touches a 31st window, and that window's whole
    // allowance is spendable inside it.
    const exposure = spendExposure({ allowance: 1n, unit: 'day', multiplier: 1, expiry: days(30) + 3_600, now: NOW });
    expect(exposure).toEqual({ periods: 31, total: 31n });
  });

  it('applies the multiplier to the window', () => {
    expect(spendExposure({ allowance: 5n, unit: 'day', multiplier: 7, expiry: days(28), now: NOW })).toEqual({
      periods: 4,
      total: 20n,
    });
  });

  // A shorter period is more money over the same time, which is the whole point
  // of showing a total rather than a rate.
  it('reports more for an hourly limit than a daily one at the same allowance', () => {
    const hourly = spendExposure({ allowance: 1n, unit: 'hour', multiplier: 1, expiry: days(1), now: NOW });
    const daily = spendExposure({ allowance: 1n, unit: 'day', multiplier: 1, expiry: days(1), now: NOW });
    expect(hourly?.total).toBe(24n);
    expect(daily?.total).toBe(1n);
  });

  it('treats forever as a single allowance for the whole permission', () => {
    expect(spendExposure({ allowance: 42n, unit: 'forever', multiplier: 1, expiry: days(365), now: NOW })).toEqual({
      periods: 1,
      total: 42n,
    });
  });

  it('returns null for a unit it does not recognise', () => {
    expect(spendExposure({ allowance: 1n, unit: 'fortnight', multiplier: 1, expiry: days(30), now: NOW })).toBeNull();
  });

  it('returns null once the permission has expired', () => {
    expect(spendExposure({ allowance: 1n, unit: 'day', multiplier: 1, expiry: days(-1), now: NOW })).toBeNull();
    expect(spendExposure({ allowance: 1n, unit: 'day', multiplier: 1, expiry: NOW, now: NOW })).toBeNull();
  });

  it('returns null rather than guessing at a broken multiplier', () => {
    expect(spendExposure({ allowance: 1n, unit: 'day', multiplier: 0, expiry: days(30), now: NOW })).toBeNull();
    expect(spendExposure({ allowance: 1n, unit: 'day', multiplier: NaN, expiry: days(30), now: NOW })).toBeNull();
  });
});

// The contract steps real calendar months from the permission start, so how many
// windows a grant touches depends on the day it is signed. Sizing a month at a
// fixed length cannot tell those apart, and rounding up for all of them doubles
// the figure on the ordinary case.
describe('a month is counted by the calendar, not by a fixed length', () => {
  const at = (year: number, month: number, day: number) => Math.floor(Date.UTC(year, month - 1, day, 12) / 1000);
  const periods = (start: number, expiry: number, multiplier = 1, unit = 'month') =>
    spendExposure({ allowance: 1n, unit, multiplier, expiry, now: start })?.periods;

  it('counts one window for a thirty-day grant signed mid-month', () => {
    expect(periods(at(2026, 1, 15), at(2026, 2, 14))).toBe(1);
  });

  it('counts two for the same length signed on a day the next month has to clamp', () => {
    // Jan 31 opens its second window on Feb 28, which a thirty-day grant outlives.
    expect(periods(at(2026, 1, 31), at(2026, 3, 2))).toBe(2);
  });

  it('counts every window the life reaches into', () => {
    expect(periods(at(2026, 1, 15), at(2026, 3, 20))).toBe(3);
  });

  // The contract's time check is inclusive, so a window opening on the exact second
  // the permission ends does exist, one instant wide. It is left out for the same
  // reason `Math.ceil` leaves it out of a fixed unit: counting it hands a whole
  // extra allowance to any grant whose expiry lands on a boundary.
  it('reads the last window as half-open, like the fixed units do', () => {
    expect(periods(at(2026, 1, 15), at(2026, 2, 15))).toBe(1);
    expect(periods(at(2026, 1, 15), at(2026, 2, 15) + 1)).toBe(2);
  });

  it('steps by the multiplier, not by single months', () => {
    expect(periods(at(2026, 1, 15), at(2026, 7, 15), 3)).toBe(2);
  });

  // The chain has no year: the SDK rewrites one into twelve months before encoding.
  it('measures a year as twelve of those months', () => {
    expect(periods(at(2026, 1, 1), at(2027, 1, 1), 1, 'year')).toBe(1);
    expect(periods(at(2026, 1, 1), at(2027, 1, 2), 1, 'year')).toBe(2);
  });
});

// `unit` is whatever the dApp wrote. A plain index would answer `constructor`
// with a function, which is truthy, and the arithmetic downstream then throws
// inside the render of the grant screen.
describe('a unit that resolves off the object prototype', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'treats %s as an unrecognised unit rather than throwing',
    (unit) => {
      expect(spendExposure({ allowance: 10n, unit, multiplier: 1, expiry: days(30), now: NOW })).toBeNull();
    }
  );
});

// Nor is it necessarily a string. The revoke path reads a numeric period enum off
// the relay, so a caller sending one on a grant is a plausible shape rather than a
// contrived one, and `.trim()` on it throws in the middle of the same render.
describe('a unit that is not a string', () => {
  it.each([[4], [{}], [['day']], [true]])('treats %s as an unrecognised unit rather than throwing', (unit) => {
    expect(
      spendExposure({ allowance: 10n, unit: unit as unknown as string, multiplier: 1, expiry: days(30), now: NOW })
    ).toBeNull();
  });
});
