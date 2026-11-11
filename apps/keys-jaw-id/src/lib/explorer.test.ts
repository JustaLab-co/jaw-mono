import { describe, expect, it } from 'vitest';

import { txUrl } from './explorer';

const hash = '0xabc';

describe('txUrl', () => {
  it('links a mainnet transaction to its explorer', () => {
    expect(txUrl(8453, hash)).toBe('https://basescan.org/tx/0xabc');
  });

  it('links a testnet transaction to its explorer', () => {
    expect(txUrl(84532, hash)).toBe('https://sepolia.basescan.org/tx/0xabc');
  });

  it('gives nothing for a chain it does not serve', () => {
    expect(txUrl(999999, hash)).toBeUndefined();
  });
});
