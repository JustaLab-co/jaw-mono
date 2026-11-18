import { describe, it, expect } from 'vitest';
import { balanceUsd, erc20FeeCost, feeTokenUsd, formatFeeAmount } from './feeCost';

// Quotes as the paymaster builds them, at ETH = $3,000 with its default 10% markup in both rates.
// `exchangeRate` is token units per 1e18 wei; `exchangeRateNativeToUsd` is USD (6 decimals) per 1e18 wei.
const MARKUP = 11n; // ×1.1, as 11/10
const NATIVE_TO_USD = (3_000n * 10n ** 6n * MARKUP) / 10n; // $3,300
// USDC at $1, 6 decimals: 3,000 per ETH at market.
const USDC = { exchangeRate: (3_000n * 10n ** 6n * MARKUP) / 10n, exchangeRateNativeToUsd: NATIVE_TO_USD };
// VVV at $3, 18 decimals: 1,000 per ETH at market.
const VVV = { exchangeRate: (1_000n * 10n ** 18n * MARKUP) / 10n, exchangeRateNativeToUsd: NATIVE_TO_USD };
// WETH, 18 decimals: 1 per ETH at market.
const WETH = { exchangeRate: (10n ** 18n * MARKUP) / 10n, exchangeRateNativeToUsd: NATIVE_TO_USD };

describe('feeTokenUsd', () => {
  it('gives the market value: the markup in both rates cancels', () => {
    // Dividing by the marked-up exchangeRate alone would show these at 1/1.1 of their value.
    expect(feeTokenUsd(100_000_000n, USDC.exchangeRate, USDC.exchangeRateNativeToUsd)).toBeCloseTo(100, 10);
    expect(feeTokenUsd(10n ** 18n, WETH.exchangeRate, WETH.exchangeRateNativeToUsd)).toBeCloseTo(3_000, 10);
    expect(feeTokenUsd(10n ** 18n, VVV.exchangeRate, VVV.exchangeRateNativeToUsd)).toBeCloseTo(3, 10);
  });

  it('prices a fee at what is charged', () => {
    // 0.0099 USDC charged is $0.0099.
    expect(feeTokenUsd(9_900n, USDC.exchangeRate, USDC.exchangeRateNativeToUsd)).toBeCloseTo(0.0099, 10);
  });

  it('prices with a real Base mainnet USDC quote', () => {
    // exchangeRate 0x767a9d09, exchangeRateNativeToUsd 0x766bf6b8: 100 USDC is about $99.95.
    expect(feeTokenUsd(100_000_000n, 0x767a9d09n, 0x766bf6b8n)).toBeCloseTo(99.9517, 4);
  });

  it('keeps the digits of a dust fee', () => {
    // 0.0000012 WETH at $3,000 is $0.0036.
    expect(feeTokenUsd(1_200_000_000_000n, WETH.exchangeRate, WETH.exchangeRateNativeToUsd)).toBeCloseTo(0.0036, 10);
  });

  it('has no dollar value without both rates', () => {
    expect(feeTokenUsd(10n ** 15n, VVV.exchangeRate, undefined)).toBeUndefined();
    expect(feeTokenUsd(10n ** 15n, VVV.exchangeRate, 0n)).toBeUndefined();
    expect(feeTokenUsd(10n ** 15n, undefined, NATIVE_TO_USD)).toBeUndefined();
    expect(feeTokenUsd(10n ** 15n, 0n, NATIVE_TO_USD)).toBeUndefined();
    expect(feeTokenUsd(undefined, VVV.exchangeRate, NATIVE_TO_USD)).toBeUndefined();
  });
});

describe('erc20FeeCost', () => {
  const vvv = {
    symbol: 'VVV',
    decimals: 18,
    gasCostFormatted: '0.0010',
    gasCostMaxFormatted: '0.0030',
    gasCost: 10n ** 15n,
    gasCostMax: 3n * 10n ** 15n,
    ...VVV,
  };

  it('shows a quoted non-stablecoin in dollars with its ceiling', () => {
    expect(erc20FeeCost(vvv)).toEqual({ formatted: '0.001 VVV', usd: '$0.0030', maxFormatted: '0.003 VVV' });
  });

  it('shows the token amount and keeps the ceiling when the quote has no USD rate', () => {
    expect(erc20FeeCost({ ...vvv, exchangeRateNativeToUsd: undefined })).toEqual({
      formatted: '0.001 VVV',
      usd: undefined,
      maxFormatted: '0.003 VVV',
    });
  });

  it('shows a dust fee in subscript notation, not rounded to 0.0000', () => {
    // core preformats a fee of 1.2e-6 WETH with a ceiling of 2.27e-6 as "0.0000".
    const weth = {
      symbol: 'WETH',
      decimals: 18,
      gasCostFormatted: '0.0000',
      gasCostMaxFormatted: '0.0000',
      gasCost: 1_200_000_000_000n,
      gasCostMax: 2_270_000_000_000n,
      ...WETH,
    };
    const cost = erc20FeeCost(weth);
    expect(cost?.formatted).toBe('0.0₅12 WETH');
    expect(cost?.maxFormatted).toBe('0.0₅227 WETH');
    expect(cost?.usd).toBe('$0.0036');
  });

  it('does not price a token at $1 because its symbol is USDC', () => {
    // A token calling itself USDC that 1 ETH buys 300,000 of at market: worth $0.01, so 0.05 is $0.0005.
    const fake = {
      symbol: 'USDC',
      decimals: 6,
      gasCostFormatted: '0.0500',
      gasCostMaxFormatted: '0.0600',
      gasCost: 50_000n,
      exchangeRate: (300_000n * 10n ** 6n * MARKUP) / 10n,
      exchangeRateNativeToUsd: NATIVE_TO_USD,
    };
    expect(erc20FeeCost(fake)?.usd).toBe('$0.0005');
  });

  it('does not price a token with no quote rates, whatever its symbol', () => {
    const unquoted = {
      symbol: 'USDC',
      decimals: 6,
      gasCostFormatted: '0.0500',
      gasCostMaxFormatted: '0.0600',
      gasCost: 50_000n,
    };
    expect(erc20FeeCost(unquoted)?.usd).toBeUndefined();
  });

  it('shows nothing for a sentinel or a missing estimate', () => {
    expect(erc20FeeCost({ ...vvv, gasCostFormatted: 'Estimation failed' })).toBeNull();
    expect(erc20FeeCost({ ...vvv, gasCostFormatted: 'Insufficient' })).toBeNull();
    expect(erc20FeeCost({ ...vvv, gasCostFormatted: undefined })).toBeNull();
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
  const ETH_PRICE = 3_000;

  it('shows ERC-20 balances at market value, not divided by the markup', () => {
    // The review's examples: 100 USDC is $100 (not $90.91), 1 WETH is $3,000 (not $2,727.27).
    const usdc = { isNative: false, balance: 100_000_000n, balanceFormatted: '100', ...USDC };
    const weth = { isNative: false, balance: 10n ** 18n, balanceFormatted: '1', ...WETH };
    expect(balanceUsd(usdc, ETH_PRICE)).toBe('$100.0000');
    expect(balanceUsd(weth, ETH_PRICE)).toBe('$3,000.0000');
  });

  it('prices an ERC-20 balance from its quote alone, without the native price', () => {
    const vvv = { isNative: false, balance: 18_920_000_000_000_000_000n, balanceFormatted: '18.92', ...VVV };
    expect(balanceUsd(vvv, 0)).toBe('$56.7600');
  });

  it('prices the native balance at the native price', () => {
    expect(balanceUsd({ isNative: true, balance: 10n ** 17n, balanceFormatted: '0.1' }, ETH_PRICE)).toBe('$300.0000');
    expect(balanceUsd({ isNative: true, balance: 10n ** 17n, balanceFormatted: '0.1' }, 0)).toBeUndefined();
  });

  it('has no dollar balance for an ERC-20 whose quote has no USD rate', () => {
    const usdc = { isNative: false, balance: 100_000_000n, balanceFormatted: '100', exchangeRate: USDC.exchangeRate };
    expect(balanceUsd(usdc, ETH_PRICE)).toBeUndefined();
    expect(balanceUsd({ isNative: false, balance: 800_000n, balanceFormatted: '0.8' }, ETH_PRICE)).toBeUndefined();
  });
});
