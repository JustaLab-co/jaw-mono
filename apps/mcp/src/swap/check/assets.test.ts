import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import type { QuoteRequest } from '../check';
import { clearsFloor, sameAsset } from './assets';

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BSC_USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const BASE_DEGEN = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';

const request = (over: Partial<QuoteRequest>): QuoteRequest => ({
  originChainId: 8453,
  originToken: BASE_USDC,
  amount: '10000000',
  account: '0x1111111111111111111111111111111111111111',
  destinationChainId: 56,
  destinationToken: BSC_USDC,
  recipient: '0x1111111111111111111111111111111111111111',
  ...over,
});

describe('sameAsset', () => {
  it('given Base USDC to BSC USDC in lowercase, when looked up, then both are USDC with 6 and 18 decimals', () => {
    expect(sameAsset(request({}))).toEqual({ decimalsIn: 6, decimalsOut: 18 });
  });

  it('given native ETH on Base to WETH on Arbitrum, when looked up, then both are ETH with 18 decimals', () => {
    const pair = sameAsset(
      request({ originToken: zeroAddress, destinationChainId: 42161, destinationToken: ARB_WETH })
    );

    expect(pair).toEqual({ decimalsIn: 18, decimalsOut: 18 });
  });

  it.each([
    ['USDC to WETH', { destinationChainId: 42161, destinationToken: ARB_WETH }],
    ['a token missing from the table', { originToken: BASE_DEGEN as QuoteRequest['originToken'] }],
    ['a destination chain with no entry', { destinationChainId: 100 }],
    [
      'a Solana destination',
      { destinationChainId: 792703809, destinationToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    ],
  ])('given %s, when looked up, then it is not the same asset', (_, over) => {
    expect(sameAsset(request(over))).toBeUndefined();
  });

  it.each([
    ['BSC', 56],
    ['Polygon', 137],
  ])('given native on %s to native ETH on Base, when looked up, then it is not the same asset', (_, chainId) => {
    const native = request({
      originChainId: chainId,
      originToken: zeroAddress,
      destinationChainId: 8453,
      destinationToken: zeroAddress,
    });

    expect(sameAsset(native)).toBeUndefined();
  });
});

describe('clearsFloor', () => {
  const usdcToBsc = { decimalsIn: 6, decimalsOut: 18 };

  it('given 10 USDC from Base to BSC, when the minimum is 9.7 USDC in 18 decimals, then it clears the 300 bps floor', () => {
    expect(clearsFloor(request({}), 9_700_000_000_000_000_000n, usdcToBsc)).toBe(true);
  });

  it('given 10 USDC from Base to BSC, when the minimum is 1 base unit under 9.7 USDC, then it does not clear', () => {
    expect(clearsFloor(request({}), 9_699_999_999_999_999_999n, usdcToBsc)).toBe(false);
  });

  it('given 10 USDC from BSC to Base, when the minimum is 9.7 USDC in 6 decimals, then it clears, and 1 unit less does not', () => {
    const back = request({
      originChainId: 56,
      originToken: BSC_USDC,
      amount: '10000000000000000000',
      destinationChainId: 8453,
      destinationToken: BASE_USDC,
    });
    const pair = { decimalsIn: 18, decimalsOut: 6 };

    expect(clearsFloor(back, 9_700_000n, pair)).toBe(true);
    expect(clearsFloor(back, 9_699_999n, pair)).toBe(false);
  });

  it('given 10 USDC from Base to Arbitrum, when the minimum is 1 base unit, then it does not clear', () => {
    const arb = request({ destinationChainId: 42161, destinationToken: ARB_USDC });

    expect(clearsFloor(arb, 1n, { decimalsIn: 6, decimalsOut: 6 })).toBe(false);
    expect(clearsFloor(arb, 9_700_000n, { decimalsIn: 6, decimalsOut: 6 })).toBe(true);
  });

  it.each(['10 USDC', '-10000000', '1e7', '', '0'])(
    'given an amount of %j, when the floor is checked, then it does not clear and does not throw',
    (amount) => {
      expect(clearsFloor(request({ amount }), 9_700_000_000_000_000_000n, usdcToBsc)).toBe(false);
    }
  );

  it('given a minimum of 0, when the floor is checked, then it does not clear', () => {
    expect(clearsFloor(request({}), 0n, usdcToBsc)).toBe(false);
  });

  it.each([
    [6, 6],
    [18, 18],
  ])(
    'given a pair of %i and %i decimals for Base USDC to BSC USDC, when the floor is checked, then it does not clear',
    (decimalsIn, decimalsOut) => {
      expect(clearsFloor(request({}), 9_700_000n, { decimalsIn, decimalsOut })).toBe(false);
    }
  );

  it('given a request that is not the same asset, when the floor is checked with a pair, then it does not clear', () => {
    const usdcToWeth = request({ destinationChainId: 42161, destinationToken: ARB_WETH });

    expect(clearsFloor(usdcToWeth, 9_700_000_000_000_000_000n, usdcToBsc)).toBe(false);
  });
});
