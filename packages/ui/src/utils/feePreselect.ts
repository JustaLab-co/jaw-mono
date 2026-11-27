import type { FeeTokenOption } from '../components/FeeTokenSelector';

/** An ERC-20 the paymaster priced and found the balance enough for: its ceiling exists only then. */
export const provenErc20 = (t: FeeTokenOption): boolean => !t.isNative && t.isSelectable && !!t.gasCostMaxFormatted;

/**
 * The fee token to open the dialog on: the coin when its balance covers `nativeNeed` (the coin
 * fee plus any value the calls send), otherwise the first ERC-20 the paymaster proved can pay.
 * Null when neither can. A coin missing from the list holds nothing, since an empty coin is
 * left out of it.
 */
export function preselectFeeToken(tokens: FeeTokenOption[], nativeNeed: bigint): FeeTokenOption | null {
  const coin = tokens.find((t) => t.isNative);
  if (coin && coin.balance >= nativeNeed) return coin;
  return tokens.find(provenErc20) ?? null;
}
