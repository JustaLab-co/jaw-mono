import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, numberToHex, stringToHex, type Hex } from 'viem';
import { decodeSymbol } from './tokenSymbol';

const word = (n: number) => numberToHex(n, { size: 32 });

describe('decodeSymbol', () => {
  it('reads a string answer', () => {
    expect(decodeSymbol(encodeAbiParameters([{ type: 'string' }], ['USDC']))).toBe('USDC');
  });

  it('reads a bytes32 answer', () => {
    expect(decodeSymbol(stringToHex('MKR', { size: 32 }))).toBe('MKR');
  });

  it.each([
    ['a string whose length runs past the data', concat([word(0x20), word(0x1000)])],
    ['a string offset that points past the data', word(0x40)],
  ] as [string, Hex][])('leaves %s unnamed', (_, data) => {
    expect(decodeSymbol(data)).toBeUndefined();
  });
});
