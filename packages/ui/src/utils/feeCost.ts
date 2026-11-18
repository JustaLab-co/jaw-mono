import { formatUnits } from 'viem';
import { subscriptDecimal } from './displayFormat';

/**
 * The market value in dollars of an amount of a fee token, from the paymaster quote's two rates.
 * `exchangeRate` is token units per 1e18 wei and `exchangeRateNativeToUsd` is USD (6 decimals) per
 * 1e18 wei. Both carry the paymaster's markup, so it cancels in their ratio:
 * `usd = amount * exchangeRateNativeToUsd / exchangeRate / 1e6`.
 *
 * Undefined without both rates. The symbol is never taken as a price, so a token that calls itself
 * "USDC" is worth whatever its rates say, not $1.
 */
export function feeTokenUsd(
  amount: bigint | undefined,
  exchangeRate: bigint | undefined,
  exchangeRateNativeToUsd: bigint | undefined
): number | undefined {
  if (amount === undefined || !exchangeRate || exchangeRate <= 0n) return undefined;
  if (!exchangeRateNativeToUsd || exchangeRateNativeToUsd <= 0n) return undefined;
  // Scaled to 18 decimals of USD so a dust fee keeps its digits through the integer division.
  const usd18 = (amount * exchangeRateNativeToUsd * 10n ** 12n) / exchangeRate;
  return Number(formatUnits(usd18, 18));
}

/** The paymaster rates of a fee token, from its estimate. */
type QuoteRates = { exchangeRate?: bigint; exchangeRateNativeToUsd?: bigint };

/**
 * A fee token's balance in dollars: the native coin at its price, an ERC-20 at the market value
 * its quote gives (`feeTokenUsd`). Undefined when there is no price for it, so the balance shows in
 * the token instead.
 */
export function balanceUsd(
  token: QuoteRates & { isNative: boolean; balance: bigint; balanceFormatted: string },
  nativeTokenPrice: number | undefined
): string | undefined {
  const usd = token.isNative
    ? nativeTokenPrice && nativeTokenPrice > 0
      ? parseFloat(token.balanceFormatted) * nativeTokenPrice
      : undefined
    : feeTokenUsd(token.balance, token.exchangeRate, token.exchangeRateNativeToUsd);
  return usd === undefined || !Number.isFinite(usd) ? undefined : formatUsd(usd);
}

/** Dollar figure with 4 decimals so a small fee is not shown as $0.00. */
export function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

/** What a fee shows: the dollar figure when there is one, and the worst-case ceiling when known. */
export interface FeeCostDisplay {
  /** Realistic fee in the token, with its symbol. */
  formatted: string;
  /** Realistic fee in dollars, or undefined when it cannot be priced. */
  usd?: string;
  /** Worst-case ceiling in the token, with its symbol. */
  maxFormatted?: string;
}

/**
 * A fee amount in a token, readable at any size: dust in subscript notation ("0.0₅227", as the
 * native fee shows it), four significant digits under one, and two decimals above.
 */
export function formatFeeAmount(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  if (n === 0) return '0';
  if (n < 0.0001) return subscriptDecimal(n);
  if (n < 1) return String(Number(n.toPrecision(4)));
  return n.toFixed(2);
}

/**
 * The cost an ERC-20 fee token shows, from its paymaster estimate. Returns null when the token
 * has no numeric estimate (none yet, or a sentinel such as "Estimation failed" or "Insufficient").
 */
export function erc20FeeCost(
  token: {
    symbol: string;
    decimals: number;
    gasCostFormatted?: string;
    gasCostMaxFormatted?: string;
    gasCost?: bigint;
    gasCostMax?: bigint;
  } & QuoteRates
): FeeCostDisplay | null {
  const { gasCostFormatted, gasCostMaxFormatted, symbol, decimals } = token;
  if (!gasCostFormatted || !Number.isFinite(Number(gasCostFormatted))) return null;
  // The raw amounts when the estimate has them: the preformatted strings round dust to "0.0000".
  const amount = token.gasCost !== undefined ? formatFeeAmount(token.gasCost, decimals) : gasCostFormatted;
  const max =
    token.gasCostMax !== undefined
      ? formatFeeAmount(token.gasCostMax, decimals)
      : gasCostMaxFormatted && Number.isFinite(Number(gasCostMaxFormatted))
        ? gasCostMaxFormatted
        : undefined;
  const usd = feeTokenUsd(token.gasCost, token.exchangeRate, token.exchangeRateNativeToUsd);
  return {
    formatted: `${amount} ${symbol}`,
    usd: usd === undefined ? undefined : formatUsd(usd),
    maxFormatted: max === undefined ? undefined : `${max} ${symbol}`,
  };
}
