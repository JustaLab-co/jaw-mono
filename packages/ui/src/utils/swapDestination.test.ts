import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getAddress } from 'viem';

import { swapDestinationOf } from './swapDestination';

const address = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((bytes) => `0x${Buffer.from(bytes).toString('hex')}`);

describe('swapDestinationOf', () => {
  it('is undefined when the request names no destination', () => {
    expect(swapDestinationOf(undefined)).toBeUndefined();
  });

  it('returns the checksummed address for an address sent lowercase or checksummed', () => {
    fc.assert(
      fc.property(address, fc.boolean(), (hex, checksummed) => {
        expect(swapDestinationOf(checksummed ? getAddress(hex) : hex)).toBe(getAddress(hex));
      })
    );
  });

  it('shows only what was sent, checksummed, and nothing for a value that is not an address', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.string(), address), (value) => {
        const shown = swapDestinationOf(value);
        if (value === undefined) {
          expect(shown).toBeUndefined();
        } else if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
          expect(shown).toBeNull();
        } else if (shown !== null) {
          expect(shown.toLowerCase()).toBe(value.toLowerCase());
          expect(shown).toBe(getAddress(shown));
        }
      })
    );
  });

  it.each([['WETH'], [''], ['0x42'], [`0x${'4'.repeat(42)}`], [null], [42], [{}]])('refuses %j', (value) => {
    expect(swapDestinationOf(value)).toBeNull();
  });

  it('refuses a mixed-case address whose checksum is wrong', () => {
    const wrong = '0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913';
    expect(swapDestinationOf(wrong)).toBeNull();
  });
});
