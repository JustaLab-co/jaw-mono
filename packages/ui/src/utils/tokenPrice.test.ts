import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokenPriceCache, fetchTokenPrice } from './tokenPrice';

/**
 * Answers like Binance's ticker endpoint seen from a browser: a listed pair gets its
 * price; an unlisted one gets a 400 with no `Access-Control-Allow-Origin`, which the
 * browser turns into a rejected fetch. `listed` is what Binance listed when this was
 * written: POL, CELO and AVAX only against USDT, USDT itself only against USD.
 */
function binance(listed: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const pair = new URL(url).searchParams.get('symbol') ?? '';
    const price = listed[pair];
    if (price === undefined) throw new TypeError('Failed to fetch'); // CORS-blocked 400
    return new Response(JSON.stringify({ symbol: pair, price }), { status: 200 });
  });
}

const pairsAsked = (fetchMock: ReturnType<typeof binance>) =>
  fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get('symbol'));

describe('fetchTokenPrice', () => {
  let fetchMock: ReturnType<typeof binance>;

  beforeEach(() => {
    clearTokenPriceCache();
    fetchMock = binance({
      ETHUSD: '1629.01',
      ETHUSDT: '1626.73',
      BNBUSDT: '541.76',
      USDCUSDT: '1.00108',
      BTCUSDT: '59148',
      POLUSDT: '0.07478',
      CELOUSDT: '0.0539',
      AVAXUSDT: '6.503',
      USDTUSD: '0.99901',
      DAIUSDT: '0.00000000', // listed, but delisted at 0
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['ETH', 1626.73],
    ['BNB', 541.76],
    ['POL', 0.07478],
    ['CELO', 0.0539],
    ['AVAX', 6.503],
  ])('prices %s from its USDT pair in one request', async (symbol, price) => {
    expect(await fetchTokenPrice(symbol)).toBe(price);
    expect(pairsAsked(fetchMock)).toEqual([`${symbol}USDT`]);
  });

  it('moves on to the USD pair when the USDT pair is refused, as a browser refuses an unlisted pair', async () => {
    expect(await fetchTokenPrice('USDT')).toBe(0.99901);
    expect(pairsAsked(fetchMock)).toEqual(['USDTUSDT', 'USDTUSD']);
  });

  it("prices Gnosis' XDAI as the dollar it is pegged to", async () => {
    expect(await fetchTokenPrice('XDAI')).toBe(1.00108);
  });

  it('keeps pricing cBTC as BTC', async () => {
    expect(await fetchTokenPrice('cBTC')).toBe(59148);
  });

  it('reads a pair listed at 0 as no price, not a price of 0', async () => {
    expect(await fetchTokenPrice('DAI')).toBe(0);
  });

  it('returns 0 for a coin no pair prices, such as FLR, after trying both', async () => {
    expect(await fetchTokenPrice('FLR')).toBe(0);
    expect(pairsAsked(fetchMock)).toEqual(['FLRUSDT', 'FLRUSD']);
  });

  it('serves a price it found from the cache', async () => {
    await fetchTokenPrice('POL');
    fetchMock.mockClear();

    expect(await fetchTokenPrice('POL')).toBe(0.07478);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 0 instead of throwing when Binance cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    expect(await fetchTokenPrice('POL')).toBe(0);
  });
});
