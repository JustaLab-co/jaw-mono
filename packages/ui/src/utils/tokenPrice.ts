// ============================================================================
// Token Price Fetching (using Binance API)
// ============================================================================

// Price cache with TTL per symbol
const tokenPriceCache: Map<string, { price: number; timestamp: number }> = new Map();
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Symbols Binance doesn't list, priced as the asset they are pegged 1:1 to
const PRICE_SYMBOL_ALIASES: Record<string, string> = {
  CBTC: 'BTC',
  XDAI: 'USDC', // Gnosis' native coin, pegged to the dollar
  // Renamed to POL and swapped 1:1. Binance halted MATICUSDT but still answers with its last trade.
  MATIC: 'POL',
};

/**
 * The pairs tried, in order. Binance lists a USD pair for only a few coins (ETH, BNB,
 * BTC, USDC); most, POL, CELO and AVAX among them, trade against USDT alone, so asking
 * only for `…USD` left every one of them unpriced. USDT comes first because every coin
 * priced here has a USDT pair, so one request answers; USD is left for USDT itself.
 */
const QUOTE_CURRENCIES = ['USDT', 'USD'] as const;

/**
 * The pair's price, or 0 when Binance does not list it or lists it at 0 (a delisted pair).
 *
 * Never throws for an unlisted pair. Binance's 400 "Invalid symbol" carries no
 * `Access-Control-Allow-Origin`, so in a browser it is not a 400 but a fetch that rejects
 * with a CORS error, and a throw here would stop the caller from trying the next pair.
 */
async function fetchPairPrice(pair: string): Promise<number> {
  try {
    const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${pair}`);
    if (!response.ok) return 0;
    // Binance returns { "symbol": "ETHUSDT", "price": "1234.56" }
    const data = await response.json();
    return Number(data.price) || 0;
  } catch {
    return 0;
  }
}

/**
 * Fetches the current price in USD for a token by its symbol from Binance API
 * Results are cached for 5 minutes per symbol to reduce API calls
 * @param symbol - The token symbol (ETH, AVAX, BNB, USDC, etc.)
 * @returns Promise<number> - The token price in USD, or 0 if no pair prices it
 */
export async function fetchTokenPrice(symbol: string): Promise<number> {
  if (!symbol) return 0;

  // Normalize symbol (remove special characters like ₮)
  const upperSymbol = symbol.replace(/[₮]/g, 'T').toUpperCase();
  const normalizedSymbol = PRICE_SYMBOL_ALIASES[upperSymbol] ?? upperSymbol;

  const cached = tokenPriceCache.get(normalizedSymbol);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached.price;
  }

  try {
    for (const quote of QUOTE_CURRENCIES) {
      const price = await fetchPairPrice(`${normalizedSymbol}${quote}`);
      if (price > 0) {
        tokenPriceCache.set(normalizedSymbol, { price, timestamp: Date.now() });
        return price;
      }
    }
    return cached?.price ?? 0;
  } catch (error) {
    console.warn(`Failed to fetch ${normalizedSymbol} price:`, error);
    return cached?.price ?? 0;
  }
}

/**
 * Clears all token price caches (useful for testing or forcing refresh)
 */
export function clearTokenPriceCache(): void {
  tokenPriceCache.clear();
}
