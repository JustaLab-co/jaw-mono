import { describe, it, expect } from 'vitest';
import { parseBigInt, parseNonNegativeBigInt } from './amount.js';

describe('parseBigInt', () => {
  it('parses a valid base-10 integer string', () => {
    expect(parseBigInt('1000000')).toBe(1000000n);
    expect(parseBigInt('0')).toBe(0n);
  });

  it("preserves negatives (sign policy is the caller's)", () => {
    expect(parseBigInt('-5')).toBe(-5n);
  });

  it('returns null for undefined, null, empty, decimals, and non-numeric', () => {
    expect(parseBigInt(undefined)).toBeNull();
    expect(parseBigInt(null)).toBeNull();
    expect(parseBigInt('')).toBeNull(); // "unset", not 0n
    expect(parseBigInt('1.5')).toBeNull();
    expect(parseBigInt('abc')).toBeNull();
  });
});

describe('parseNonNegativeBigInt', () => {
  it('returns the value when non-negative', () => {
    expect(parseNonNegativeBigInt('750000')).toBe(750000n);
    expect(parseNonNegativeBigInt('0')).toBe(0n);
  });

  it('returns undefined for negative, invalid, or absent', () => {
    expect(parseNonNegativeBigInt('-1')).toBeUndefined();
    expect(parseNonNegativeBigInt('nope')).toBeUndefined();
    expect(parseNonNegativeBigInt(undefined)).toBeUndefined();
  });
});
