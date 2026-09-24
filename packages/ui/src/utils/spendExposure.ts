/**
 * How much a spend limit can move over the whole life of a permission.
 *
 * The grant screen shows a rate: "10 USDC /day". That is not what is being
 * approved. What is being approved is that rate for as long as the permission
 * lives, and the grant carries its own expiry, so a 30-day one authorises 300.
 * The larger figure appears nowhere in the product, which is why a permission
 * asking for a million reads as tidily as one asking for ten.
 */

/**
 * Fixed-length windows in seconds, matching `_fixedPeriodDuration` in
 * `JustaPermissionManager`.
 */
const FIXED_SECONDS: Record<string, number> = {
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
};

/**
 * Months per window for the units the contract steps by the calendar.
 *
 * The chain has no year. The SDK rewrites one into twelve months before
 * encoding, so it is counted as twelve of them.
 */
const MONTHS_PER_WINDOW: Record<string, number> = {
  month: 1,
  year: 12,
};

export interface SpendExposureArgs {
  /** Base units the limit allows per window. */
  allowance: bigint;
  unit: string;
  multiplier: number;
  /** Unix seconds the permission ends at. */
  expiry: number;
  /**
   * Unix seconds. A grant starts when it is signed, so this is its start.
   *
   * Read at render, while the contract anchors windows to the timestamp stamped
   * when the user confirms. Render time is the earlier of the two, so the life
   * measured here is never shorter than the real one and the count never comes
   * out low. A dialog left open only goes further that way, never the other.
   */
  now: number;
}

export interface SpendExposure {
  /** Windows the permission's life touches. */
  periods: number;
  /** The most the limit can move across all of them, in base units. */
  total: bigint;
}

/**
 * `timestamp` moved by whole months, with the day clamped to the end of the
 * target month the way the contract's `addMonths` does: a window opened on
 * Jan 31 next opens on Feb 28. Null when the date falls outside `Date`'s range.
 */
function addMonths(timestamp: number, months: number): number | null {
  const from = new Date(timestamp * 1000);
  if (Number.isNaN(from.getTime())) return null;

  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  // Day 0 of the following month is the last day of the target one.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const moved = Date.UTC(
    year,
    month,
    Math.min(from.getUTCDate(), lastDay),
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds()
  );
  return Number.isNaN(moved) ? null : Math.floor(moved / 1000);
}

/**
 * Windows a calendar-stepped permission touches, counted rather than divided.
 *
 * The contract anchors month windows to the permission start and steps real
 * calendar months from it, so a 30-day grant signed on the 15th touches one
 * window and the same grant signed on the 31st touches two. A division by a
 * fixed month length cannot tell those apart and has to round up for both,
 * which doubles the figure on the ordinary one. This mirrors the contract's own
 * index arithmetic instead.
 *
 * The life is read half-open, the way `Math.ceil` reads it for the fixed units.
 * The contract's time check is inclusive, so a window opening on the exact second
 * the permission ends does exist, but it is one instant wide (`periodEnd` is
 * capped at the permission end) and reachable only by landing a transaction in
 * that block. Counting it would hand a whole extra allowance to any grant whose
 * expiry happens to fall on a boundary.
 */
function monthWindows(start: number, expiry: number, monthsPerWindow: number): number | null {
  const last = expiry - 1;
  const from = new Date(start * 1000);
  const to = new Date(last * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;

  // Calendar months land on the month boundary, not on the anchor day, so this
  // overshoots by one until the day comes round: Jan 15 to Feb 14 reads as one
  // month while the window that opened on Jan 15 is still the current one.
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  const index = Math.floor(months / monthsPerWindow);

  const opened = addMonths(start, index * monthsPerWindow);
  if (opened === null) return null;
  return opened > last ? index : index + 1;
}

/**
 * The exposure of one spend limit, or null when it cannot be sized.
 *
 * Null rather than a guess for a unit we do not recognise or an expiry already
 * past: a total the screen cannot stand behind is worse than no total, because
 * the user reads it as the bound.
 */
export function spendExposure({ allowance, unit, multiplier, expiry, now }: SpendExposureArgs): SpendExposure | null {
  if (allowance < 0n) return null;

  // `unit` is only typed as a period. It arrives off the grant request and nothing
  // validates it at runtime, so it may not be a string at all: the sibling revoke
  // path reads a numeric enum off the relay, and `.trim()` on that throws inside
  // the render of the screen the user approves on.
  const key = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
  // One allowance for the entire permission, so the rate is already the total.
  if (key === 'forever') return { periods: 1, total: allowance };

  if (!Number.isFinite(multiplier) || multiplier < 1) return null;
  const multiple = Math.floor(multiplier);

  const life = expiry - now;
  if (!Number.isFinite(life) || life <= 0) return null;

  // Own keys only. A plain index answers `constructor` with a function, which is
  // truthy, and `BigInt(NaN)` then throws in the same render. Same reason
  // `usdcForNetwork` in the CLI guards its lookup.
  if (Object.hasOwn(MONTHS_PER_WINDOW, key)) {
    const periods = monthWindows(now, expiry, MONTHS_PER_WINDOW[key] * multiple);
    if (periods === null) return null;
    return { periods, total: allowance * BigInt(periods) };
  }

  if (!Object.hasOwn(FIXED_SECONDS, key)) return null;
  const periods = Math.ceil(life / (FIXED_SECONDS[key] * multiple));
  return { periods, total: allowance * BigInt(periods) };
}
