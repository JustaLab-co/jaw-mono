import { formatUnits } from 'viem';
import { subscriptDecimal } from './displayFormat';

/**
 * The dollar value of an amount of a fee token, from the paymaster quote's exchange rate and the
 * native coin's price. `exchangeRate` is native wei to the token's smallest unit, so
 * `amount * 1e18 / exchangeRate` is the amount in wei. That is the gas the native coin would pay,
 * so a fee shows about the same dollar figure whichever token pays it.
 *
 * Returns undefined when there is no rate or no price. The symbol is never taken as a price, so a
 * token that calls itself "USDC" is worth whatever its rate says, not $1.
 */
export function feeTokenUsd(
  amount: bigint | undefined,
  exchangeRate: bigint | undefined,
  nativeTokenPrice: number | undefined
): number | undefined {
  if (amount === undefined || exchangeRate === undefined || exchangeRate <= 0n) return undefined;
  if (!nativeTokenPrice || !(nativeTokenPrice > 0)) return undefined;
  const wei = (amount * 10n ** 18n) / exchangeRate;
  return Number(formatUnits(wei, 18)) * nativeTokenPrice;
}

/**
 * A fee token's balance in dollars: the native coin at its price, an ERC-20 through the paymaster
 * rate from its estimate (as `feeTokenUsd`). The rate may carry the paymaster's markup, so an
 * ERC-20 figure is approximate. Undefined without a price, or for an ERC-20 not yet quoted.
 */
export function balanceUsd(
  token: { isNative: boolean; balance: bigint; balanceFormatted: string; exchangeRate?: bigint },
  nativeTokenPrice: number | undefined
): string | undefined {
  if (!nativeTokenPrice || !(nativeTokenPrice > 0)) return undefined;
  const usd = token.isNative
    ? parseFloat(token.balanceFormatted) * nativeTokenPrice
    : feeTokenUsd(token.balance, token.exchangeRate, nativeTokenPrice);
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
    exchangeRate?: bigint;
  },
  nativeTokenPrice: number | undefined
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
  const usd = feeTokenUsd(token.gasCost, token.exchangeRate, nativeTokenPrice);
  return {
    formatted: `${amount} ${symbol}`,
    usd: usd === undefined ? undefined : formatUsd(usd),
    maxFormatted: max === undefined ? undefined : `${max} ${symbol}`,
  };
}
