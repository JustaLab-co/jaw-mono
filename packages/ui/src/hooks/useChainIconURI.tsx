import { JSX, useState, useEffect, useMemo } from 'react';
import { handleGetCapabilitiesRequest, peekCapabilities, type ChainMetadataCapability } from '@jaw.id/core';

/** The icon the cache can answer with, or undefined when it cannot answer at all. */
function cachedIcon(chainId: number, apiKey?: string): { icon: string | null } | undefined {
  if (!chainId) return undefined;
  const chainIdHex = `0x${chainId.toString(16)}` as `0x${string}`;
  const capabilities = peekCapabilities(
    { method: 'wallet_getCapabilities', params: [undefined, [chainIdHex]] },
    apiKey,
    true
  );
  if (!capabilities) return undefined;
  const metadata = capabilities[chainIdHex]?.chainMetadata as ChainMetadataCapability | undefined;
  return { icon: metadata?.icon ?? null };
}

/**
 * Hook to fetch chain icon from wallet_getCapabilities chainMetadata
 * Returns a JSX element (img or fallback) similar to useChainIcon
 *
 * The response is cached by `handleGetCapabilitiesRequest`, which also shares one
 * request between callers that mount together. A mount that the cache can already
 * answer reads it synchronously and asks nothing: awaiting a warm entry still
 * paints the placeholder for a frame, on every dialog that shows a chain.
 *
 * @param chainId - The chain ID to get the icon for
 * @param apiKey - The API key for authentication, if the caller has one
 * @param size - The size of the icon in pixels (default: 24)
 * @returns JSX.Element - The chain icon or a fallback element
 */
export const useChainIconURI = (chainId: number, apiKey?: string, size?: number): JSX.Element => {
  const iconSize = size ?? 24;

  // Read once: every read clones the cached response, and the two states below
  // and StrictMode would otherwise ask for the same answer four times a mount.
  const [seeded] = useState(() => cachedIcon(chainId, apiKey));
  const [iconURI, setIconURI] = useState<string | null>(seeded?.icon ?? null);
  const [isLoading, setIsLoading] = useState(!seeded);

  useEffect(() => {
    // Whatever the cache says about this chain, which is nothing at all when it
    // has not been asked yet. Either way the icon of the chain we were rendering
    // before comes off: a mounted dialog can switch chain, and keeping it up
    // would put the wrong one on the screen for the length of the lookup.
    const cached = cachedIcon(chainId, apiKey);
    setIconURI(cached?.icon ?? null);

    if (cached || !chainId) {
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    const fetchCapabilities = async () => {
      setIsLoading(true);
      try {
        const chainIdHex = `0x${chainId.toString(16)}` as `0x${string}`;
        const capabilities = await handleGetCapabilitiesRequest(
          {
            method: 'wallet_getCapabilities',
            params: [undefined, [chainIdHex]],
          },
          apiKey,
          true // showTestnets to get all chains
        );

        if (isMounted) {
          const chainCapabilities = capabilities[chainIdHex];
          const chainMetadata = chainCapabilities?.chainMetadata as ChainMetadataCapability | undefined;
          setIconURI(chainMetadata?.icon ?? null);
          setIsLoading(false);
        }
      } catch (error) {
        console.warn(`Failed to fetch capabilities for chain ${chainId}:`, error);
        if (isMounted) {
          setIconURI(null);
          setIsLoading(false);
        }
      }
    };

    fetchCapabilities();

    return () => {
      isMounted = false;
    };
  }, [chainId, apiKey]);

  // Memoize the JSX to prevent unnecessary re-renders
  const icon = useMemo(() => {
    // If we have a URI from capabilities, use it
    if (iconURI) {
      return (
        <img
          src={iconURI}
          alt={`Chain ${chainId} icon`}
          style={{
            width: iconSize,
            height: iconSize,
            minWidth: iconSize,
            borderRadius: '50%',
          }}
        />
      );
    }

    // Show loading state or fallback
    return (
      <div
        style={{
          backgroundColor: isLoading ? 'oklch(var(--jaw-color-muted))' : 'oklch(var(--jaw-color-secondary))',
          border: '1px solid oklch(var(--jaw-color-border))',
          display: 'flex',
          height: `${iconSize}px`,
          width: `${iconSize}px`,
          minWidth: `${iconSize}px`,
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          borderRadius: '50%',
          fontSize: `${Math.max(10, iconSize / 3)}px`,
          color: 'oklch(var(--jaw-color-muted-foreground))',
        }}
      >
        {isLoading ? '...' : '?'}
      </div>
    );
  }, [iconURI, chainId, iconSize, isLoading]);

  return icon;
};
