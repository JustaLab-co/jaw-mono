import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  identityRevision,
  peekIdentity,
  requestIdentity,
  subscribeIdentities,
  type IdentitySource,
} from '../utils/addressIdentity';
import { formatAddress } from '../utils/formatAddress';
import { identityKey, type ReverseInput } from '../utils/reverseResolve';

export type { IdentitySource } from '../utils/addressIdentity';

export interface AddressIdentity {
  address: string;
  chainId: number;
  /** Primary ENS name, suffixed `@chainlabel` off-mainnet. For showing. */
  ensName: string | null;
  /** The same name without the suffix. For anything acted on: copying, resolving. */
  ensPlainName: string | null;
  /** ENS avatar, served through the ENS metadata proxy. */
  ensAvatar: string | null;
  tokenName: string | null;
  tokenSymbol: string | null;
  tokenIcon: string | null;
  /** ERC-7730 contract name, e.g. "Uniswap V3 Router 2". */
  clearSigningName: string | null;
  /** Null for now: ERC-7730 has no logo yet, and no other source covers these contracts. */
  clearSigningIcon: string | null;
  /** The best name available: ENS name, then clear-signing name, then token symbol, then the short address. */
  label: string;
  /** Per source, whether its answer is still on the way. False for a source that was not included. */
  loading: Record<IdentitySource, boolean>;
}

export interface UseAddressIdentityOptions {
  mainnetRpcUrl: string;
  apiKey?: string;
  /** The sources to ask. Defaults to all three; a screen that shows only names can skip the rest. */
  include?: readonly IdentitySource[];
}

const ALL_SOURCES: readonly IdentitySource[] = ['ens', 'token', 'clearSigning'];

function buildIdentity(input: ReverseInput, include: readonly IdentitySource[]): AddressIdentity {
  const answer = <S extends IdentitySource>(source: S) =>
    include.includes(source) ? peekIdentity(source, input) : { value: null, loading: false };
  const ens = answer('ens');
  const token = answer('token');
  const clearSigning = answer('clearSigning');

  return {
    address: input.address,
    chainId: input.chainId,
    ensName: ens.value?.name ?? null,
    ensPlainName: ens.value?.plainName ?? null,
    ensAvatar: ens.value?.avatar ?? null,
    tokenName: token.value?.name ?? null,
    tokenSymbol: token.value?.symbol ?? null,
    tokenIcon: token.value?.icon ?? null,
    clearSigningName: clearSigning.value?.name ?? null,
    // ERC-7730 descriptors carry no logo, and the token icon endpoint answers 404 for most
    // contracts, so there is no source to point at yet.
    clearSigningIcon: null,
    label: ens.value?.name ?? clearSigning.value?.name ?? token.value?.symbol ?? formatAddress(input.address),
    loading: { ens: ens.loading, token: token.loading, clearSigning: clearSigning.loading },
  };
}

/**
 * Resolves each address to everything it is known by: ENS name and avatar, token name,
 * symbol and icon, and clear-signing name. Keyed by `identityKey(address, chainId)`.
 *
 * Fields fill in as each source answers, so callers render `label` straight away and
 * it upgrades in place. Every address asked for in the same render, across every
 * component using this hook, goes out in one ENS request; answers are remembered for
 * the session, and a remembered one is there on the first render.
 */
export function useAddressIdentities(
  inputs: readonly ReverseInput[],
  { mainnetRpcUrl, apiKey, include = ALL_SOURCES }: UseAddressIdentityOptions
): Record<string, AddressIdentity> {
  const inputsKey = inputs.map((i) => identityKey(i.address, i.chainId)).join('|');
  const includeKey = include.join('|');
  // Built from this hook's own keys only, so an answer for another address re-renders nothing here.
  const revisions = () => inputs.flatMap((input) => include.map((source) => identityRevision(source, input))).join(',');
  const snapshot = useSyncExternalStore(subscribeIdentities, revisions, revisions);

  useEffect(() => {
    for (const input of inputs) {
      for (const source of include) requestIdentity(source, input, { mainnetRpcUrl, apiKey });
    }
  }, [inputsKey, includeKey, mainnetRpcUrl, apiKey]);

  return useMemo(() => {
    const identities: Record<string, AddressIdentity> = {};
    for (const input of inputs) {
      identities[identityKey(input.address, input.chainId)] = buildIdentity(input, include);
    }
    return identities;
  }, [inputsKey, includeKey, snapshot]);
}

/** {@link useAddressIdentities} for one address. Null until both the address and the chain are known. */
export function useAddressIdentity(
  address: string | undefined,
  chainId: number | undefined,
  options: UseAddressIdentityOptions
): AddressIdentity | null {
  const inputs = address && chainId ? [{ address, chainId }] : [];
  const identities = useAddressIdentities(inputs, options);
  return address && chainId ? (identities[identityKey(address, chainId)] ?? null) : null;
}
