import { SUPPORTED_CHAINS } from '@jaw.id/core';

/**
 * The symbol of a chain's native coin, from where it is known, in order:
 * the native fee-token entry (what `wallet_getAssets` reported), the chain
 * object the dapp sent, then the chain's own definition.
 *
 * Undefined when none of them knows it. Never a guess: the symbol also picks
 * the price the dialogs show, so a default of "ETH" labelled POL, CELO or BNB
 * amounts as ETH and priced them at ETH's price.
 */
export function resolveNativeSymbol({
  feeTokenSymbol,
  nativeCurrencySymbol,
  chainId,
}: {
  feeTokenSymbol?: string;
  nativeCurrencySymbol?: string;
  chainId?: number;
}): string | undefined {
  return (
    feeTokenSymbol ||
    nativeCurrencySymbol ||
    SUPPORTED_CHAINS.find((chain) => chain.id === chainId)?.nativeCurrency.symbol ||
    undefined
  );
}
