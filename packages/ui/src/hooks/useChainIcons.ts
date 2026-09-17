import { useEffect, useState } from 'react';
import { handleGetCapabilitiesRequest, type ChainMetadataCapability } from '@jaw.id/core';

/** chainId -> icon data URI, for whatever the capabilities response carried. */
export type ChainIconMap = Readonly<Record<number, string>>;

// Keyed on the api key alone: the request below is the same for every caller,
// so one entry serves them all. Module-level, like useChainIconURI's cache, so
// this is a first-open cost per session rather than per mount.
const iconsCache = new Map<string, ChainIconMap>();
const inflight = new Map<string, Promise<ChainIconMap>>();

/**
 * Every chain's icon in one request.
 *
 * `useChainIconURI` asks for a single chain (`params: [undefined, [chainIdHex]]`)
 * and the capabilities cache is keyed on those params, so a component rendering
 * N chains issued N round trips — 14 for the mainnet stack.
 *
 * This asks with `params: []` instead, which is the request
 * `ReactUIHandler`, `PermissionModal` and `TransactionModal` already make for
 * their fee tokens. It resolves to the same cache entry, so the icons usually
 * arrive without a network call at all.
 *
 * Deliberately separate from `useChainIconURI` rather than a change to it: six
 * call sites use that hook for one chain, and making it fetch every chain would
 * put a whole-catalogue payload behind every signing dialog.
 */
export function useChainIcons(apiKey?: string): ChainIconMap {
  const [icons, setIcons] = useState<ChainIconMap>(() => (apiKey ? (iconsCache.get(apiKey) ?? {}) : {}));

  useEffect(() => {
    if (!apiKey) return;

    const cached = iconsCache.get(apiKey);
    if (cached) {
      setIcons(cached);
      return;
    }

    let active = true;

    // Shared so two stacks mounting together (dialog + popup) still make one
    // request, which the per-chain hook could not do.
    let request = inflight.get(apiKey);
    if (!request) {
      request = handleGetCapabilitiesRequest(
        { method: 'wallet_getCapabilities', params: [] },
        apiKey,
        true // showTestnets: matches the other all-chain callers, so the cache entry is shared
      )
        .then((capabilities) => {
          const map: Record<number, string> = {};
          for (const [chainIdHex, chainCapabilities] of Object.entries(capabilities)) {
            const metadata = (chainCapabilities as { chainMetadata?: ChainMetadataCapability }).chainMetadata;
            if (metadata?.icon) map[Number(chainIdHex)] = metadata.icon;
          }
          iconsCache.set(apiKey, map);
          return map as ChainIconMap;
        })
        .finally(() => {
          inflight.delete(apiKey);
        });
      inflight.set(apiKey, request);
    }

    request
      .then((map) => {
        if (active) setIcons(map);
      })
      .catch(() => {
        // Icons are decoration on this screen; the address and the QR do not
        // depend on them, so a failure leaves the fallback glyphs in place.
      });

    return () => {
      active = false;
    };
  }, [apiKey]);

  return icons;
}
