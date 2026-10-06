/**
 * Spend-limit period windows, mirroring `JustaPermissionManager._getCurrentPeriod`.
 *
 * A granted allowance is per period, not per session: the contract rebuilds a
 * fresh window once the previous one elapses, so the allowance resets. The local
 * policy has to compute the same window to refuse for the same reason the chain
 * would, before a signature is produced.
 */

/** Period units the contract's `PeriodUnit` enum accepts. */
export const PERIOD_UNITS = ['minute', 'hour', 'day', 'week', 'month', 'forever'] as const;
export type PeriodUnit = (typeof PERIOD_UNITS)[number];

export function isPeriodUnit(value: unknown): value is PeriodUnit {
  return typeof value === 'string' && (PERIOD_UNITS as readonly string[]).includes(value);
}

/**
 * Normalise a granted spend's unit and multiplier to what the contract stores.
 *
 * The CLI and the SDK both accept `year`, which has no `PeriodUnit` on chain:
 * `permissionToContractFormat` rewrites it to `month` with the multiplier times
 * twelve before encoding. This mirrors that, so a yearly grant lands on the same
 * window locally as the one the permission actually enforces. Returns undefined
 * for a unit with no on-chain meaning, which callers treat as "no period
 * recorded" rather than guessing a window.
 */
export function normalizePeriod(
  unit: string | undefined,
  multiplier?: number
): { unit: PeriodUnit; multiplier: number } | undefined {
  const m = Math.max(1, Math.floor(multiplier ?? 1));
  if (unit === 'year') return { unit: 'month', multiplier: m * 12 };
  if (isPeriodUnit(unit)) return { unit, multiplier: m };
  return undefined;
}

/** Seconds per fixed-duration unit. `month` is calendar-based, `forever` unbounded. */
const FIXED_UNIT_SECONDS: Record<Exclude<PeriodUnit, 'month' | 'forever'>, number> = {
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
};

export interface PeriodWindow {
  /** Unix seconds, inclusive. */
  start: number;
  /** Unix seconds, exclusive, clamped at the permission's expiry. */
  end: number;
}

export interface PeriodWindowInput {
  /** Unix seconds the periods are anchored at (the permission's start). */
  anchor: number;
  unit: PeriodUnit;
  /** Period multiplier, >= 1. Values below 1 are treated as 1, matching the grant default. */
  multiplier?: number;
  /** Unix seconds to locate the window around. */
  now: number;
  /** Unix seconds the permission expires. The window never extends past it. */
  permissionEnd: number;
}

/**
 * Add `months` calendar months to a unix timestamp, clamping the day-of-month to
 * the target month's length. Mirrors Solady's `DateTimeLib.addMonths`, which the
 * contract uses: Jan 31 plus one month is Feb 28, not Mar 3.
 */
function addMonths(unixSeconds: number, months: number): number {
  const d = new Date(unixSeconds * 1000);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
  );
  // Day 0 of the following month is the last day of the target month.
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return Math.floor(target.getTime() / 1000);
}

/**
 * The period window containing `now`, anchored at the permission start.
 *
 * `forever` is a single window spanning the whole permission, which is why a
 * `forever` grant behaves like a plain session-wide cap. Fixed units step in
 * whole durations from the anchor. `month` steps in calendar months.
 *
 * `now` before the anchor yields the first window rather than a negative index,
 * so a small clock skew between the grant and the local machine cannot produce a
 * window in the past.
 */
export function currentPeriodWindow(input: PeriodWindowInput): PeriodWindow {
  const { anchor, unit, now, permissionEnd } = input;
  const multiplier = Math.max(1, Math.floor(input.multiplier ?? 1));

  if (unit === 'forever') {
    return { start: anchor, end: permissionEnd };
  }

  let start: number;
  let end: number;

  if (unit === 'month') {
    // Walk calendar months from the anchor. Month lengths vary, so stepping is
    // the honest way to find the index; grants run for a bounded number of
    // periods, and the loop is cheap next to the network call it guards.
    let index = 0;
    let cursor = anchor;
    let next = addMonths(anchor, multiplier);
    while (next <= now) {
      index += 1;
      cursor = next;
      next = addMonths(anchor, (index + 1) * multiplier);
    }
    start = cursor;
    end = next;
  } else {
    const duration = FIXED_UNIT_SECONDS[unit] * multiplier;
    const elapsed = Math.max(0, now - anchor);
    const index = Math.floor(elapsed / duration);
    start = anchor + index * duration;
    end = start + duration;
  }

  // The contract caps the window at the permission end; past expiry nothing is
  // spendable anyway, so a degenerate window is the correct answer.
  return { start, end: Math.min(end, permissionEnd) };
}

/** Human-readable period label for refusal messages, e.g. "day" or "3 days". */
export function describePeriod(unit: PeriodUnit, multiplier?: number): string {
  // 'the whole permission' reads right inside a refusal about an allowance and
  // wrong after 'per', which is why the plain form below is its own function
  // rather than a flag on this one.
  if (unit === 'forever') return 'the whole permission';
  return describeSpendPeriod(unit, multiplier);
}

/**
 * The window as it reads after "used" or "for": `this day`, or, for a cap over
 * the whole grant, `the whole permission`. The plain form reads wrong after
 * "this", which is where both the report and the refusals put it.
 */
export function describePeriodPhrase(unit: PeriodUnit, multiplier?: number): string {
  return unit === 'forever' ? describePeriod(unit) : `this ${describePeriod(unit, multiplier)}`;
}

/**
 * A spend limit's window, as it reads after "per".
 *
 * Takes a plain string because a grant may say `year`, which is not a
 * `PeriodUnit`: the contract has no such unit and the SDK rewrites it to months
 * before encoding, but the document the user wrote still says it.
 *
 * Here rather than beside each caller. Two byte-identical copies of this had
 * grown in `grant-ceiling` and `merge-permissions`, the second one added while
 * fixing a review comment about the first.
 */
export function describeSpendPeriod(unit: string, multiplier?: number): string {
  const n = Math.max(1, Math.floor(multiplier ?? 1));
  return n === 1 ? unit : `${n} ${unit}s`;
}

/**
 * How long one period lasts in seconds, at its shortest or its longest.
 *
 * Two bounds because a calendar month is 28 to 31 days and a year 365 or 366,
 * and which end to take depends on which side of a comparison the period is on:
 * measuring a grant at its shortest and a ceiling at its longest keeps the
 * rounding from opening either one up. `year` is here even though the contract
 * has no such unit, because a grant may be written with it and the SDK rewrites
 * it to months before encoding.
 *
 * Returns null for a unit with no meaning, which callers treat as "cannot be
 * compared" rather than guessing a length.
 */
export function periodLengthSeconds(unit: string, multiplier: number, bound: 'min' | 'max'): number | null {
  const lengths: Record<string, number> = {
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: (bound === 'min' ? 28 : 31) * 86400,
    year: (bound === 'min' ? 365 : 366) * 86400,
    forever: Number.POSITIVE_INFINITY,
  };
  if (!Object.hasOwn(lengths, unit)) return null;
  return lengths[unit] * Math.max(1, Math.floor(multiplier));
}
