import { useState, useEffect } from 'react';

import { reverseResolveWithAvatars } from '../utils/reverseResolve';
import { getChainLabel } from '../utils/resolveChainLabel';

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
 * upgrade in place — e.g. `name ?? formatAddress(address)`. Shared by every
 * dialog that shows an account (Connect, Signature, …) so the resolution/cancel
 * logic lives in one place.
 */
export function useReverseIdentity(
  address: string | undefined,
  chainId: number | undefined,
  mainnetRpcUrl: string
): ReverseIdentity {
  const [name, setName] = useState<string | null>(null);
  const [plainName, setPlainName] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    setName(null);
    setPlainName(null);
    setAvatar(null);
    if (!address || !chainId) return;
    let cancelled = false;
    reverseResolveWithAvatars([{ address, chainId }], mainnetRpcUrl)
      .then(async (resolved) => {
        if (cancelled) return;
        const identity = resolved[address.toLowerCase()];
        if (identity) {
          const label = await getChainLabel(chainId, mainnetRpcUrl);
          if (cancelled) return;
          setName(label ? `${identity.name}@${label}` : identity.name);
          setPlainName(identity.name);
          setAvatar(identity.avatar ?? null);
        }
      })
      .catch(() => {
        // Silently fall back to the address + blob
      });
    return () => {
      cancelled = true;
    };
  }, [address, chainId, mainnetRpcUrl]);

  return { name, plainName, avatar };
}
