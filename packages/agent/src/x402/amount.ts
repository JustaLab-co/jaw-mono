/**
 * Canonical base-unit amount parser. Every place that turns an amount string
 * (from an untrusted 402 challenge or from hand-edited config) into a bigint
 * goes through here, so the failure surface is uniform and a malformed value
 * can never crash a hot path. Sign policy is left to the caller: this returns
 * the parsed value (which may be negative) or null when it is not an integer.
 */
export function parseBigInt(value: string | undefined | null): bigint | null {
  // Empty string is "unset", not zero: BigInt('') is 0n, but an absent config
  // value must read as null so callers treat it as "no bound", not "cap of 0".
  if (value === undefined || value === null || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Parse a non-negative base-unit amount; undefined when absent, invalid, or negative. */
export function parseNonNegativeBigInt(value: string | undefined | null): bigint | undefined {
  const parsed = parseBigInt(value);
  return parsed !== null && parsed >= 0n ? parsed : undefined;
}
