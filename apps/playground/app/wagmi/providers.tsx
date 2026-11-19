'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { createWagmiConfig, type ModeType, type TransportModeType } from './config';
import { type PaymasterConfig, type JawTheme } from '@jaw.id/core';
import { useState, useMemo, useRef, type PropsWithChildren } from 'react';
import type { Config } from 'wagmi';

// One id per config object, so the provider remounts exactly when the config is rebuilt.
const configIds = new WeakMap<Config, number>();
let nextConfigId = 0;
function configKey(config: Config): number {
  let id = configIds.get(config);
  if (id === undefined) {
    id = ++nextConfigId;
    configIds.set(config, id);
  }
  return id;
}

interface WagmiProvidersProps extends PropsWithChildren {
  mode: ModeType;
  paymasters?: Record<number, PaymasterConfig>;
  theme?: JawTheme;
  transportMode?: TransportModeType;
}

export function WagmiProviders({ children, mode, paymasters, theme, transportMode }: WagmiProvidersProps) {
  const [queryClient] = useState(() => new QueryClient());
  // Build the connector once with the INITIAL theme. Later theme changes are
  // pushed to the live keys dialog via connector.setTheme (see WagmiPageContent),
  // NOT by rebuilding the connector — a rebuild re-prewarms a fresh iframe and
  // can leave a stale one behind (the theme-sync timing bug this fix closes).
  const initialTheme = useRef(theme).current;
  const config = useMemo(
    () => createWagmiConfig(mode, paymasters, initialTheme, transportMode),
    [mode, paymasters, initialTheme, transportMode]
  );

  // The config is built with `ssr: true` (see config.ts), so wagmi restores the saved connection
  // and reconnects in an effect that runs once per mount of WagmiProvider. A rebuilt config (mode,
  // transport or paymasters changed) needs its own mount, or it would show as disconnected.
  return (
    <WagmiProvider key={configKey(config)} config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
