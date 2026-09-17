import { JSX, useState, useEffect, useMemo } from 'react';
import { handleGetCapabilitiesRequest, type ChainMetadataCapability } from '@jaw.id/core';

/**
 * Hook to fetch chain icon from wallet_getCapabilities chainMetadata
 * Returns a JSX element (img or fallback) similar to useChainIcon
 *
 * The response is cached by `handleGetCapabilitiesRequest`, which also shares one
 * request between callers that mount together, so this asks on every mount.
 *
 * @param chainId - The chain ID to get the icon for
 * @param apiKey - The API key for authentication, if the caller has one
 * @param size - The size of the icon in pixels (default: 24)
 * @returns JSX.Element - The chain icon or a fallback element
 */
export const useChainIconURI = (chainId: number, apiKey?: string, size?: number): JSX.Element => {
  const iconSize = size ?? 24;

  const [iconURI, setIconURI] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // The icon on screen belongs to the chain we were rendering before, and a
    // mounted dialog can switch chain: drop it rather than keep it up, both
    // through the lookup and when the new chain is one we cannot ask about.
    setIconURI(null);

    if (!chainId) {
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
