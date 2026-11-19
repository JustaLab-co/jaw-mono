import { http, createConfig, type Config } from 'wagmi';
import type { Chain } from 'viem';
import { jaw } from '@jaw.id/wagmi';
import { Mode, SUPPORTED_CHAINS, type PaymasterConfig, type JawTheme } from '@jaw.id/core';
import { ReactUIHandler } from '@jaw.id/ui';
import { resolveKeysUrl } from '../../lib/keys-url';

export type ModeType = (typeof Mode)[keyof typeof Mode];

export type TransportModeType = 'popup' | 'iframe' | 'auto';

export function createWagmiConfig(
  mode: ModeType,
  paymasters?: Record<number, PaymasterConfig>,
  theme?: JawTheme,
  transportMode?: TransportModeType
): Config {
  const defaultChainId = process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID
    ? Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID)
    : 84532; // Base Sepolia

  const transports = Object.fromEntries(SUPPORTED_CHAINS.map((chain) => [chain.id, http()]));

  const keysUrl = resolveKeysUrl();

  return createConfig({
    // Hydrate after mount: without this, wagmi reconnects during render and React warns
    // "Cannot update a component while rendering a different component (`Hydrate`)".
    ssr: true,
    chains: SUPPORTED_CHAINS as unknown as readonly [Chain, ...Chain[]],
    connectors: [
      jaw({
        apiKey: process.env.NEXT_PUBLIC_API_KEY || '',
        appName: 'JAW Wagmi Demo',
        appLogoUrl: 'https://avatars.githubusercontent.com/u/159771991?s=200&v=4',
        defaultChainId,
        preference: {
          ...(keysUrl && { keysUrl }),
          showTestnets: true,
          mode: mode,
          ...(transportMode && { transportMode }),
          uiHandler: mode === Mode.AppSpecific ? new ReactUIHandler({ theme }) : undefined,
        },
        ens: process.env.NEXT_PUBLIC_ENS || 'justan.id',
        paymasters,
        theme,
      }),
    ],
    transports,
  });
}

// Register the config's inferred type with wagmi for end-to-end type safety.
// Derived from the factory's return type — we intentionally do NOT construct a
// module-scope config instance (that would run on every SSR pass with no
// `window`, building and discarding a throwaway connector); the live config is
// built client-side in WagmiProviders via useMemo.
declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof createWagmiConfig>;
  }
}
