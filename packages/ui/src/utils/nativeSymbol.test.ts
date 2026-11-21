import { describe, expect, it } from 'vitest';
import { resolveNativeSymbol } from './nativeSymbol';

describe('resolveNativeSymbol', () => {
  it.each([
    [137, 'POL'],
    [42220, 'CELO'],
    [56, 'BNB'],
    [43114, 'AVAX'],
    [5042, 'USDC'],
    [8453, 'ETH'],
  ])("names chain %i's native coin %s from the chain itself when nothing else does", (chainId, symbol) => {
    expect(resolveNativeSymbol({ chainId })).toBe(symbol);
  });

  it('prefers the native fee-token entry, then the chain object the dapp sent', () => {
    expect(resolveNativeSymbol({ feeTokenSymbol: 'xDAI', nativeCurrencySymbol: 'XDAI', chainId: 100 })).toBe('xDAI');
    expect(resolveNativeSymbol({ nativeCurrencySymbol: 'POL', chainId: 137 })).toBe('POL');
  });

  // Arc's native row came back from wallet_getAssets with no symbol.
  it('skips an empty fee-token symbol instead of showing nothing', () => {
    expect(resolveNativeSymbol({ feeTokenSymbol: '', chainId: 5042 })).toBe('USDC');
  });

  it('does not guess ETH for a chain it does not know', () => {
    expect(resolveNativeSymbol({ chainId: 999_999 })).toBeUndefined();
    expect(resolveNativeSymbol({})).toBeUndefined();
  });
});
