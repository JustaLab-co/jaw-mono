import { describe, it, expect } from 'vitest';
import { balanceUsd, erc20FeeCost, feeTokenUsd, formatFeeAmount } from './feeCost';

// `exchangeRate` is the token's smallest units per 1e18 wei (one native coin).
const ETH_PRICE = 3000;
// VVV at $3 with 18 decimals: 1 ETH buys 1000 VVV.
const VVV_RATE = 1000n * 10n ** 18n;
// USDC at $1 with 6 decimals: 1 ETH buys 3000 USDC.
const USDC_RATE = 3000n * 10n ** 6n;

describe('feeTokenUsd', () => {
  it('prices a non-stablecoin fee from the quote rate and the native price', () => {
    // 0.001 VVV at $3 = $0.003
    expect(feeTokenUsd(10n ** 15n, VVV_RATE, ETH_PRICE)).toBeCloseTo(0.003, 10);
  });

  it('prices a real stablecoin at about $1', () => {
    // 0.05 USDC
    expect(feeTokenUsd(50_000n, USDC_RATE, ETH_PRICE)).toBeCloseTo(0.05, 10);
  });

  it('has no dollar value without a native price or a rate', () => {
    expect(feeTokenUsd(10n ** 15n, VVV_RATE, 0)).toBeUndefined();
    expect(feeTokenUsd(10n ** 15n, VVV_RATE, undefined)).toBeUndefined();
    expect(feeTokenUsd(10n ** 15n, undefined, ETH_PRICE)).toBeUndefined();
    expect(feeTokenUsd(10n ** 15n, 0n, ETH_PRICE)).toBeUndefined();
    expect(feeTokenUsd(undefined, VVV_RATE, ETH_PRICE)).toBeUndefined();
  });
});

describe('erc20FeeCost', () => {
  const vvv = {
    symbol: 'VVV',
    decimals: 18,
    gasCostFormatted: '0.0010',
    gasCostMaxFormatted: '0.0030',
    gasCost: 10n ** 15n,
    exchangeRate: VVV_RATE,
  };

  it('shows a quoted non-stablecoin in dollars with its ceiling', () => {
    expect(erc20FeeCost({ ...vvv, gasCostMax: 3n * 10n ** 15n }, ETH_PRICE)).toEqual({
      formatted: '0.001 VVV',
      usd: '$0.0030',
      maxFormatted: '0.003 VVV',
    });
  });

  it('keeps the ceiling when there is no native price', () => {
    expect(erc20FeeCost({ ...vvv, gasCostMax: 3n * 10n ** 15n }, 0)).toEqual({
      formatted: '0.001 VVV',
      usd: undefined,
      maxFormatted: '0.003 VVV',
    });
  });

  it('shows a dust fee in subscript notation, not rounded to 0.0000', () => {
    // A WETH fee of 1.2e-6 with a ceiling of 2.27e-6: core preformats both as "0.0000".
    const weth = {
      symbol: 'WETH',
      decimals: 18,
      gasCostFormatted: '0.0000',
      gasCostMaxFormatted: '0.0000',
      gasCost: 1_200_000_000_000n,
      gasCostMax: 2_270_000_000_000n,
      exchangeRate: 10n ** 18n,
    };
    const cost = erc20FeeCost(weth, ETH_PRICE);
    expect(cost?.formatted).toBe('0.0₅12 WETH');
    expect(cost?.maxFormatted).toBe('0.0₅227 WETH');
    expect(cost?.usd).toBe('$0.0036');
  });

  it('does not price a token at $1 because its symbol is USDC', () => {
    // A token calling itself USDC that 1 ETH buys 300,000 of: worth $0.01, so 0.05 of it is $0.0005.
    const fake = {
      symbol: 'USDC',
      decimals: 6,
      gasCostFormatted: '0.0500',
      gasCostMaxFormatted: '0.0600',
      gasCost: 50_000n,
      exchangeRate: 300_000n * 10n ** 6n,
    };
    expect(erc20FeeCost(fake, ETH_PRICE)?.usd).toBe('$0.0005');
  });

  it('does not price a token with no quote rate, whatever its symbol', () => {
    const unquoted = {
      symbol: 'USDC',
      decimals: 6,
      gasCostFormatted: '0.0500',
      gasCostMaxFormatted: '0.0600',
      gasCost: 50_000n,
    };
    expect(erc20FeeCost(unquoted, ETH_PRICE)?.usd).toBeUndefined();
  });

  it('shows nothing for a sentinel or a missing estimate', () => {
    expect(erc20FeeCost({ ...vvv, gasCostFormatted: 'Estimation failed' }, ETH_PRICE)).toBeNull();
    expect(erc20FeeCost({ ...vvv, gasCostFormatted: 'Insufficient' }, ETH_PRICE)).toBeNull();
    expect(erc20FeeCost({ ...vvv, gasCostFormatted: undefined }, ETH_PRICE)).toBeNull();
  });
});

describe('formatFeeAmount', () => {
  it('formats a fee readably at every size', () => {
    expect(formatFeeAmount(0n, 18)).toBe('0');
    expect(formatFeeAmount(2_270_000_000_000n, 18)).toBe('0.0₅227');
    expect(formatFeeAmount(367_123_456_000_000_000n, 18)).toBe('0.3671');
    expect(formatFeeAmount(20_500n, 6)).toBe('0.0205');
    expect(formatFeeAmount(12_345_678n, 6)).toBe('12.35');
  });
});

describe('balanceUsd', () => {
  it('prices an ERC-20 balance through its quote rate', () => {
    // 18.92 VVV at $3
    const vvv = {
      isNative: false,
      balance: 18_920_000_000_000_000_000n,
      balanceFormatted: '18.92',
      exchangeRate: VVV_RATE,
    };
    expect(balanceUsd(vvv, ETH_PRICE)).toBe('$56.7600');
  });

  it('prices a dust WETH balance', () => {
    // 0.00011 WETH, 1:1 with ETH
    const weth = {
      isNative: false,
      balance: 110_000_000_000_000n,
      balanceFormatted: '0.00011',
      exchangeRate: 10n ** 18n,
    };
    expect(balanceUsd(weth, ETH_PRICE)).toBe('$0.3300');
  });

  it('prices the native balance at the native price', () => {
    expect(balanceUsd({ isNative: true, balance: 10n ** 17n, balanceFormatted: '0.1' }, ETH_PRICE)).toBe('$300.0000');
  });

  it('has no dollar balance without a price, or for an ERC-20 not yet quoted', () => {
    expect(balanceUsd({ isNative: true, balance: 10n ** 17n, balanceFormatted: '0.1' }, 0)).toBeUndefined();
    expect(balanceUsd({ isNative: false, balance: 800_000n, balanceFormatted: '0.8' }, ETH_PRICE)).toBeUndefined();
  });
});
