import { describe, expect, it } from 'vitest';
import {
  chainName,
  expiresIn,
  explorerTxUrl,
  formatAmount,
  nativeSymbol,
  onDate,
  receiptLine,
  withinWindow,
} from './owner-text';

const TX = `0x${'ab'.repeat(32)}`;
// No chain viem or JAW defines has this id.
const UNKNOWN = 987_654_321_987;
// Viem's local chain: a name, and no block explorer.
const LOCALHOST = 1337;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const after = (ms: number) => new Date(NOW.getTime() + ms);
const MINUTE = 60_000;

describe('chainName', () => {
  it.each([
    [8453, 'Base'],
    [84532, 'Base Sepolia'],
    [1, 'Ethereum'],
    // As the wallet's own screens name them.
    [42161, 'Arbitrum One'],
    [10, 'OP Mainnet'],
  ])('given chain %i, then it is %s', (id, name) => {
    expect(chainName(id)).toBe(name);
  });

  it('given a chain JAW does not serve, then it is the name viem knows it by', () => {
    expect(chainName(324)).toBe('ZKsync Era');
  });

  it('given a chain nobody knows, then it falls back to its CAIP-2 id', () => {
    expect(chainName(UNKNOWN)).toBe(`eip155:${UNKNOWN}`);
  });
});

describe('explorerTxUrl', () => {
  it('given Base, then it is the transaction page on its block explorer', () => {
    expect(explorerTxUrl(8453, TX)).toBe(`https://basescan.org/tx/${TX}`);
  });

  it('given Base Sepolia, then it is the testnet explorer', () => {
    expect(explorerTxUrl(84532, TX)).toBe(`https://sepolia.basescan.org/tx/${TX}`);
  });

  it('given an explorer url that ends in a slash, then the link has no double slash', () => {
    expect(explorerTxUrl(11142220, TX)).toBe(`https://celo-sepolia.blockscout.com/tx/${TX}`);
  });

  it('given a chain with no block explorer, then there is no link', () => {
    expect(explorerTxUrl(LOCALHOST, TX)).toBeUndefined();
  });

  it('given a chain nobody knows, then there is no link', () => {
    expect(explorerTxUrl(UNKNOWN, TX)).toBeUndefined();
  });
});

describe('receiptLine', () => {
  it('given a chain with an explorer, then it is a receipt link', () => {
    expect(receiptLine(8453, TX)).toBe(`Receipt: https://basescan.org/tx/${TX}`);
  });

  it('given a chain with no explorer, then it is the transaction hash', () => {
    expect(receiptLine(LOCALHOST, TX)).toBe(`Transaction: ${TX}`);
    expect(receiptLine(UNKNOWN, TX)).toBe(`Transaction: ${TX}`);
  });
});

describe('nativeSymbol', () => {
  it.each([
    [8453, 'ETH'],
    [42161, 'ETH'],
    [10, 'ETH'],
    [1, 'ETH'],
    [137, 'POL'],
  ])('given chain %i, then its coin is %s', (id, symbol) => {
    expect(nativeSymbol(id)).toBe(symbol);
  });

  it('given a chain nobody knows, then it names no token it cannot know', () => {
    expect(nativeSymbol(UNKNOWN)).toBe('native coin');
  });
});

describe('formatAmount', () => {
  it.each([
    [1_500_000n, 6, 'USDC', '1.50 USDC'],
    [1_000_000n, 6, 'USDC', '1 USDC'],
    [490_000n, 6, 'USDC', '0.49 USDC'],
    [50_000n, 6, 'USDC', '0.05 USDC'],
    [123_456n, 6, 'USDC', '0.123456 USDC'],
    [12_500_000n, 6, 'USDC', '12.50 USDC'],
    [0n, 6, 'USDC', '0 USDC'],
    [10_000_000_000_000_000n, 18, 'ETH', '0.01 ETH'],
    [100_000_000_000_000_000n, 18, 'ETH', '0.10 ETH'],
  ])('given %s base units at %i decimals of %s, then it reads %s', (units, decimals, symbol, shown) => {
    expect(formatAmount(units, decimals, symbol)).toBe(shown);
  });

  it('given base units as a decimal string, then it reads the same as the number', () => {
    expect(formatAmount('1500000', 6, 'USDC')).toBe('1.50 USDC');
  });

  it('given the smallest unit of an 18-decimal coin, then it is exact and not in scientific notation', () => {
    expect(formatAmount(1n, 18, 'ETH')).toBe('0.000000000000000001 ETH');
  });

  it('given a very large amount, then it is written out in full', () => {
    expect(formatAmount(10n ** 30n, 6, 'USDC')).toBe('1000000000000000000000000 USDC');
  });

  it('given a token with no decimals, then it is the whole number', () => {
    expect(formatAmount(42n, 0, 'TKN')).toBe('42 TKN');
  });
});

describe('withinWindow', () => {
  it('given the full 30 minutes ahead, then it says so', () => {
    expect(withinWindow(after(30 * MINUTE), NOW)).toBe('within the next 30 minutes');
  });

  it('given a moment already gone from the window, then it rounds up to the minute', () => {
    expect(withinWindow(after(30 * MINUTE - 500), NOW)).toBe('within the next 30 minutes');
  });

  it('given under a minute left, then it is the next minute', () => {
    expect(withinWindow(after(1), NOW)).toBe('within the next minute');
  });

  it('given no time left, then it says so rather than promising time', () => {
    expect(withinWindow(NOW, NOW)).toBe('with no time left to approve');
    expect(withinWindow(after(-MINUTE), NOW)).toBe('with no time left to approve');
  });

  it('given no now, then it measures from the clock', () => {
    expect(withinWindow(new Date(Date.now() + 10 * MINUTE))).toBe('within the next 10 minutes');
  });
});

describe('expiresIn', () => {
  it('given 12 and a half minutes left, then it rounds down, so it never overstates', () => {
    expect(expiresIn(after(12.5 * MINUTE), NOW)).toBe('expires in 12 minutes');
  });

  it('given exactly one minute left, then it is one minute', () => {
    expect(expiresIn(after(MINUTE), NOW)).toBe('expires in 1 minute');
  });

  it('given less than a minute left, then it says under a minute', () => {
    expect(expiresIn(after(59_999), NOW)).toBe('expires in under a minute');
  });

  it('given the moment it ends or later, then it has expired', () => {
    expect(expiresIn(NOW, NOW)).toBe('has expired');
    expect(expiresIn(after(-5_000), NOW)).toBe('has expired');
  });

  it('given no now, then it measures from the clock', () => {
    expect(expiresIn(new Date(Date.now() + 20 * MINUTE + 30_000))).toBe('expires in 20 minutes');
  });
});

describe('onDate', () => {
  it('given a date, then it is day, short month and year, with no time', () => {
    expect(onDate(new Date('2026-11-22T09:15:00.000Z'))).toBe('22 Nov 2026');
  });

  it('given the last second of a day in UTC, then it is still that day', () => {
    expect(onDate(new Date('2026-11-22T23:59:59.999Z'))).toBe('22 Nov 2026');
  });

  it('given a time written in another zone, then the day is the one in UTC', () => {
    expect(onDate(new Date('2026-11-22T23:30:00-05:00'))).toBe('23 Nov 2026');
  });

  it('given September, then the month is Sep, as on every other runtime', () => {
    expect(onDate(new Date('2026-09-01T00:00:00.000Z'))).toBe('1 Sep 2026');
  });
});
