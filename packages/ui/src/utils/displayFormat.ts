// ============================================================================
// Shared value formatting for signing UIs.
// ----------------------------------------------------------------------------
// One home for the "make an integer human" rules so the raw EIP-712 tree and the
// clear-signed card render numbers, dates, and "unlimited"/"no expiry" sentinels
// identically. Core-free (viem only).
// ============================================================================

import { formatEther, formatUnits, maxUint160, maxUint256 } from 'viem';

// Plausible unix-timestamp window (2000-01-01 .. 2100-01-01) for date detection.
export const TS_MIN = 946684800n;
export const TS_MAX = 4102444800n;

/** Thousands-separate a decimal number string ("1000000.5" → "1,000,000.5"), sign-aware. */
export function groupNumber(s: string): string {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart] = body.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (fracPart ? `${grouped}.${fracPart}` : grouped);
}

/**
 * Subscript zero-count notation for a tiny positive decimal, à la DexScreener:
 * `0.000002732` → `"0.0₅2732"` (the subscript = how many zeros follow the decimal
 * before the first significant digit). Use in place of a flat "<0.0001".
 *
 * There is no Intl / `toLocaleString` option for this — it's a crypto display
 * convention — so we derive it from `toExponential`, which returns an exactly-rounded
 * mantissa + base-10 exponent (`"2.732e-6"`). That gives the zero count (`-exp - 1`)
 * and the significant digits directly, with no fixed-width padding or `log10` float
 * error. `sig` caps the significant digits. Pair with `<SubText>` to render the count
 * as a real `<sub>`. Returns "0" for non-positive / non-finite / non-fractional input.
 */
const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
export function subscriptDecimal(value: number, sig = 4): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const [mantissa, expPart] = value.toExponential(Math.max(0, sig - 1)).split('e');
  const exp = Number(expPart);
  if (exp >= 0) return '0'; // not a sub-1 fraction; caller only formats tiny values
  const zeros = -exp - 1; // leading zeros between the decimal point and the first digit
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  const sub = String(zeros).replace(/\d/g, (d) => SUB_DIGITS[Number(d)]);
  return `0.0${sub}${digits}`;
}

/**
 * Format a transaction `value` — always wei, hex or decimal per EIP-1474/5792 — as a
 * decimal native amount. Never infer the unit: the same string is passed to `BigInt`
 * when the call is built, so display and signed intent must parse it identically.
 * Null when there's nothing honest to show (absent, zero, negative, unparseable).
 */
export function formatNativeValue(value?: string): string | null {
  if (!value) return null;
  try {
    const wei = BigInt(value);
    return wei <= 0n ? null : formatEther(wei);
  } catch {
    return null;
  }
}

export interface SpendAmountDisplay {
  /** Scaled amount, or raw base units when the token's decimals couldn't be read. */
  amount: string;
  /** True when `amount` is unscaled — the UI must say so rather than imply a denomination. */
  decimalsUnknown: boolean;
}

/**
 * Format a spend allowance for display. The ERC-20 counterpart to `formatNativeValue`, and the
 * same rule: never infer the unit.
 *
 * There is no safe default for unknown decimals. Assuming 18 renders a 100 USDC/day cap as
 * "0.0000000001" — off by 10^12, and wrong in the direction that makes a large authorization look
 * like dust, which a token that reverts `decimals()` gets for free. The transaction screen already
 * refuses to guess (`clearSigning/format.ts` renders raw wei as `kind: 'raw'`; `assetPreview.ts`
 * drops the row). A spend limit can't be dropped — the user is being asked to approve it — so it
 * reports raw base units and flags itself for the UI to label.
 */
export function formatSpendAmount(allowance: bigint, decimals: number | null | undefined): SpendAmountDisplay {
  if (decimals === null || decimals === undefined) {
    return { amount: allowance.toString(), decimalsUnknown: true };
  }
  return { amount: formatUnits(allowance, decimals), decimalsUnknown: false };
}

/**
 * Whether a spend amount is too long to sit beside the token identity, and should drop to its own
 * line a size smaller.
 *
 * The digits are never abbreviated — a cap the user is being asked to approve has to be legible in
 * full, and an unscaled base-units figure runs to tens of digits (78 for a max-uint allowance) — so
 * the layout yields instead of the number. 12 characters is where a 13px semibold figure stops
 * fitting next to the token symbol and its rate at the dialog's width.
 */
export function isLongSpendAmount(amount: string): boolean {
  return amount.length > 12;
}

/** Largest value a `uint<bits>` can hold — used to spot "unlimited"/"no expiry" sentinels. */
export function maxUintFor(type: string): bigint | null {
  const m = /^uint(\d*)$/.exec(type);
  if (!m) return null;
  const bits = m[1] ? Number(m[1]) : 256;
  return (1n << BigInt(bits)) - 1n;
}

/** True when a raw amount is a common "unlimited approval" sentinel (uint256 / uint160 max). */
export function isUnlimitedAmount(raw: string | bigint | undefined | null): boolean {
  if (raw === undefined || raw === null || raw === '') return false;
  try {
    const v = typeof raw === 'bigint' ? raw : BigInt(raw);
    return v === maxUint256 || v === maxUint160;
  } catch {
    return false;
  }
}

/** True when a value plausibly encodes a unix-seconds timestamp. */
export function isUnixTimestamp(n: bigint): boolean {
  return n >= TS_MIN && n <= TS_MAX;
}

export type DateTone = 'expired' | 'far' | 'normal';

/** A deadline bounds when a signature can be used; a start is when it begins to be valid. */
export type DateKind = 'deadline' | 'start';

/** True when a field, by name or dotted path, is when a signature starts being valid (`validAfter`, `notBefore`, …). */
export function isStartField(name: string): boolean {
  const last = name.split('.').pop() ?? name;
  return /^(validafter|validfrom|notbefore|starttime)$/.test(last.toLowerCase().replace(/_/g, ''));
}

// A deadline more than ~1 year out is "far" — a soft warning for unusually long-lived
// approvals/permits (a max-uint sentinel is handled separately as "No expiry").
const ONE_YEAR_SECONDS = 31_536_000n;

/**
 * Classify a unix-seconds date relative to now:
 *  - `expired` — a deadline already in the past (a signature with this deadline is unexecutable → warn).
 *                A start in the past is `normal`: the signature is already valid.
 *  - `far`     — more than a year out (soft warn)
 *  - `normal`  — within the next year
 */
export function dateTone(raw: string | bigint, kind: DateKind = 'deadline'): DateTone {
  let n: bigint;
  try {
    n = typeof raw === 'bigint' ? raw : BigInt(raw);
  } catch {
    return 'normal';
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (n < now) return kind === 'start' ? 'normal' : 'expired';
  if (n > now + ONE_YEAR_SECONDS) return 'far';
  return 'normal';
}

/** Format unix seconds as "1 Jan 2030" (day-first, abbreviated month). Falls back to the grouped integer. */
export function formatUnixDate(raw: string | bigint): string {
  let n: bigint;
  try {
    n = typeof raw === 'bigint' ? raw : BigInt(raw);
  } catch {
    return String(raw);
  }
  const d = new Date(Number(n) * 1000);
  if (Number.isNaN(d.getTime())) return groupNumber(n.toString());
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
