import { describe, it, expect } from 'vitest';
import { usdcBalance } from './balance.js';

const OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

describe('usdcBalance', () => {
  it('formats a balance for a supported network', async () => {
    const result = await usdcBalance('eip155:84532', OWNER, async () => 1_500_000n);
    expect(result).toEqual({
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      raw: '1500000',
      formatted: '1.5',
    });
  });

  it('reports a zero balance', async () => {
    const result = await usdcBalance('eip155:8453', OWNER, async () => 0n);
    expect(result.raw).toBe('0');
    expect(result.formatted).toBe('0');
  });

  it('throws on an unsupported network', async () => {
    await expect(usdcBalance('eip155:1', OWNER, async () => 0n)).rejects.toThrow(/Unsupported x402 network/);
  });
});
