// ============================================================================
// Token Price Fetching (using Binance API)
// ============================================================================

// Price cache with TTL per symbol
const tokenPriceCache: Map<string, { price: number; timestamp: number }> = new Map();
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Symbols Binance doesn't list, priced as the asset they are pegged 1:1 to
const PRICE_SYMBOL_ALIASES: Record<string, string> = {
  CBTC: 'BTC',
};

/**
 * Fetches the current price in USD for a token by its symbol from Binance API
 * Results are cached for 5 minutes per symbol to reduce API calls
 * @param symbol - The token symbol (ETH, AVAX, BNB, USDC, etc.)
 * @returns Promise<number> - The token price in USD, or 0 if fetch fails
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
    const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${normalizedSymbol}USD`);

    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status}`);
    }

    const data = await response.json();

    // Binance returns { "symbol": "ETHUSD", "price": "1234.56" }
    const price = Number(data.price) || 0;

    tokenPriceCache.set(normalizedSymbol, { price, timestamp: Date.now() });
    return price;
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
