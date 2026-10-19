import { ENS_ONLY } from '../utils/addressIdentity';
import { useAddressIdentity } from './useAddressIdentities';

export interface ReverseIdentity {
  /** Reverse-resolved primary ENS name (suffixed `@chainlabel` off-mainnet), or null. */
  name: string | null;
  /**
   * The same name without the `@chainlabel` suffix, or null.
   *
   * `name` is for showing, this is for anything acted on: the suffix says which
   * chain the name was read on, and `alice.eth@base` resolves nowhere, so
   * copying or resolving it hands the user a string no wallet accepts.
   */
  plainName: string | null;
  /** ENS avatar URL, or null. */
  avatar: string | null;
}

/**
 * Reverse-resolves an address to its primary ENS name + avatar. Returns nulls
 * until (or unless) resolution succeeds, so callers render the address first and
 * upgrade in place — e.g. `name ?? formatAddress(address)`.
 *
 * The ENS-only view of {@link useAddressIdentity}, so it shares that hook's batching
 * and session cache.
 */
export function useReverseIdentity(
  address: string | undefined,
  chainId: number | undefined,
  mainnetRpcUrl: string
): ReverseIdentity {
  const identity = useAddressIdentity(address, chainId, { mainnetRpcUrl, include: ENS_ONLY });
  return {
    name: identity?.ensName ?? null,
    plainName: identity?.ensPlainName ?? null,
    avatar: identity?.ensAvatar ?? null,
  };
}
