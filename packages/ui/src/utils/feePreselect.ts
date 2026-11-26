import type { FeeTokenOption } from '../components/FeeTokenSelector';
import type { AssetDelta } from './assetPreview';

/** What the batch moves out of the account in `address`, by the asset preview. Zero with no preview. */
export function outflowOf(assetsOut: readonly AssetDelta[] | undefined, address: string): bigint {
  const token = address.toLowerCase();
  return (assetsOut ?? [])
    .filter((d) => d.direction === 'out' && d.address.toLowerCase() === token)
    .reduce((sum, d) => sum - d.diff, 0n);
}

/** A fee token pays only from what the batch leaves of it. */
export const paysAfterOutflow = (balance: bigint, outflow: bigint, cost: bigint): boolean => balance - outflow >= cost;

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
