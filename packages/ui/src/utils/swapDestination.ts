import { getAddress, isAddress, type Address } from 'viem';

/**
 * The one token swaps under a grant may buy, from `capabilities.swapDestination` as the requester
 * sent it. Shown only, never signed. `undefined` when there is none; `null` when it is not an
 * address, which refuses the request rather than hiding the row.
 */
export function swapDestinationOf(value: unknown): Address | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
}
