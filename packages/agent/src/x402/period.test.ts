import { describe, it, expect } from 'vitest';
import { currentPeriodWindow, describePeriod, isPeriodUnit, normalizePeriod, PERIOD_UNITS } from './period.js';

const iso = (s: string) => Math.floor(Date.parse(s) / 1000);
const at = (start: number) => new Date(start * 1000).toISOString();

const ANCHOR = iso('2026-01-01T00:00:00Z');
const FAR = iso('2030-01-01T00:00:00Z');

describe('currentPeriodWindow', () => {
  it('returns the first window while inside it', () => {
    const w = currentPeriodWindow({ anchor: ANCHOR, unit: 'day', now: ANCHOR + 3600, permissionEnd: FAR });
    expect(at(w.start)).toBe('2026-01-01T00:00:00.000Z');
    expect(at(w.end)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('steps to the window containing now', () => {
    // Two and a half days in: the third daily window.
    const w = currentPeriodWindow({ anchor: ANCHOR, unit: 'day', now: ANCHOR + 2 * 86400 + 43200, permissionEnd: FAR });
    expect(at(w.start)).toBe('2026-01-03T00:00:00.000Z');
    expect(at(w.end)).toBe('2026-01-04T00:00:00.000Z');
  });

  it('honours the multiplier', () => {
    const w = currentPeriodWindow({
      anchor: ANCHOR,
      unit: 'day',
      multiplier: 3,
      now: ANCHOR + 4 * 86400,
      permissionEnd: FAR,
    });
    expect(at(w.start)).toBe('2026-01-04T00:00:00.000Z');
    expect(at(w.end)).toBe('2026-01-07T00:00:00.000Z');
  });

  it('a boundary instant belongs to the new window, not the old one', () => {
    const w = currentPeriodWindow({ anchor: ANCHOR, unit: 'day', now: ANCHOR + 86400, permissionEnd: FAR });
    expect(at(w.start)).toBe('2026-01-02T00:00:00.000Z');
  });

  it.each(['minute', 'hour', 'week'] as const)('handles the fixed unit %s', (unit) => {
    const seconds = { minute: 60, hour: 3600, week: 604800 }[unit];
    const w = currentPeriodWindow({ anchor: ANCHOR, unit, now: ANCHOR + seconds + 1, permissionEnd: FAR });
    expect(w.start).toBe(ANCHOR + seconds);
    expect(w.end).toBe(ANCHOR + 2 * seconds);
  });

  it('forever is a single window spanning the permission', () => {
    const end = iso('2026-03-01T00:00:00Z');
    const w = currentPeriodWindow({ anchor: ANCHOR, unit: 'forever', now: ANCHOR + 86400, permissionEnd: end });
    expect(w.start).toBe(ANCHOR);
    expect(w.end).toBe(end);
  });

  it('steps calendar months rather than fixed 30-day blocks', () => {
    // Feb is 28 days in 2026, so a fixed-duration month would land mid-March.
    const w = currentPeriodWindow({
      anchor: ANCHOR,
      unit: 'month',
      now: iso('2026-02-15T00:00:00Z'),
      permissionEnd: FAR,
    });
    expect(at(w.start)).toBe('2026-02-01T00:00:00.000Z');
    expect(at(w.end)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('clamps the day of month, mirroring the contract addMonths', () => {
    // Jan 31 plus one month is Feb 28, not Mar 3.
    const jan31 = iso('2026-01-31T00:00:00Z');
    const w = currentPeriodWindow({ anchor: jan31, unit: 'month', now: jan31 + 3600, permissionEnd: FAR });
    expect(at(w.end)).toBe('2026-02-28T00:00:00.000Z');
  });

  it('never extends past the permission end', () => {
    const end = ANCHOR + 86400 + 3600; // expires mid-way through the second day
    const w = currentPeriodWindow({ anchor: ANCHOR, unit: 'day', now: ANCHOR + 86400 + 60, permissionEnd: end });
    expect(w.start).toBe(ANCHOR + 86400);
    expect(w.end).toBe(end);
  });

  it('clamps a now before the anchor to the first window instead of a negative index', () => {
    const w = currentPeriodWindow({ anchor: ANCHOR, unit: 'day', now: ANCHOR - 5000, permissionEnd: FAR });
    expect(w.start).toBe(ANCHOR);
  });

  it('treats a zero or negative multiplier as 1', () => {
    const w = currentPeriodWindow({ anchor: ANCHOR, unit: 'day', multiplier: 0, now: ANCHOR + 60, permissionEnd: FAR });
    expect(w.end - w.start).toBe(86400);
  });
});

describe('isPeriodUnit', () => {
  it('accepts every unit the contract enum defines', () => {
    for (const unit of PERIOD_UNITS) expect(isPeriodUnit(unit)).toBe(true);
  });

  // The contract enum is Minute|Hour|Day|Week|Month|Forever. 'year' is accepted
  // at the CLI and SDK edges but is not one of these, so it is not a unit here.
  it('rejects year and other non-units', () => {
    expect(isPeriodUnit('year')).toBe(false);
    expect(isPeriodUnit('decade')).toBe(false);
    expect(isPeriodUnit(undefined)).toBe(false);
  });
});

describe('normalizePeriod', () => {
  it('rewrites year to twelve months, matching permissionToContractFormat', () => {
    expect(normalizePeriod('year')).toEqual({ unit: 'month', multiplier: 12 });
    expect(normalizePeriod('year', 2)).toEqual({ unit: 'month', multiplier: 24 });
  });

  it('passes on-chain units through with a defaulted multiplier', () => {
    expect(normalizePeriod('day')).toEqual({ unit: 'day', multiplier: 1 });
    expect(normalizePeriod('week', 3)).toEqual({ unit: 'week', multiplier: 3 });
  });

  it('returns undefined for a unit with no on-chain meaning', () => {
    expect(normalizePeriod('decade')).toBeUndefined();
    expect(normalizePeriod(undefined)).toBeUndefined();
  });

  it('a yearly window really is twelve calendar months long', () => {
    const anchor = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);
    const p = normalizePeriod('year');
    const w = currentPeriodWindow({
      anchor,
      unit: p.unit,
      multiplier: p.multiplier,
      now: anchor + 86400,
      permissionEnd: Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000),
    });
    expect(new Date(w.end * 1000).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('describePeriod', () => {
  it('reads naturally in a refusal message', () => {
    expect(describePeriod('day')).toBe('day');
    expect(describePeriod('day', 3)).toBe('3 days');
    expect(describePeriod('forever')).toBe('the whole permission');
  });
});
