import { JAW } from '@jaw.id/core';
import { resolveKeysUrl } from './keys-url';
import { ARB_SEPOLIA_ID } from './eure';

/** Arbitrum Sepolia: the one chain the demo runs on. */
export const DEMO_CHAIN_ID = ARB_SEPOLIA_ID;

/**
 * Effective keys transport, for analytics. The demo asks for the iframe, but
 * that needs a secure context — on plain http://localhost the SDK falls back to
 * the popup on its own, so report what will actually be used.
 */
export function transportMode(): 'iframe' | 'popup' {
  return typeof window !== 'undefined' && window.isSecureContext ? 'iframe' : 'popup';
}

// One CrossPlatform SDK instance for the whole demo. The iframe transport is
// persistent: it mounts hidden + handshakes once (prewarm on provider
// construction) and every later request re-shows the same keys.jaw.id iframe,
// so the wallet session survives across demo screens without reconnecting.
let sdk: ReturnType<typeof JAW.create> | null = null;

export function getJaw() {
  if (typeof window === 'undefined') return null;
  if (!sdk) {
    const apiKey = process.env.NEXT_PUBLIC_API_KEY;
    if (!apiKey) {
      // An empty key makes JAW.create come up with zero chains/clients and
      // every request fails obscurely — fail loudly instead.
      const msg =
        'NEXT_PUBLIC_API_KEY is not set — copy apps/demo/.env.example to apps/demo/.env.local and fill in a key from https://dashboard.jaw.id/';
      if (process.env.NODE_ENV !== 'production') throw new Error(msg);
      console.error(msg);
    }
    const keysUrl = resolveKeysUrl();
    sdk = JAW.create({
      apiKey: apiKey || '',
      appName: 'JAW Demo',
      appLogoUrl: 'https://avatars.githubusercontent.com/u/159771991?s=200&v=4',
      defaultChainId: DEMO_CHAIN_ID,
      preference: {
        // Explicit local override or this PR's own keys preview, same
        // convention as playground.
        ...(keysUrl ? { keysUrl } : {}),
        showTestnets: true,
        // ENS parent the demo issues subnames from (user.justan.id).
        ens: process.env.NEXT_PUBLIC_ENS || '',
        // iframe requires a secure context; on plain http://localhost the SDK
        // falls back to the popup on its own.
        transportMode: 'iframe',
      },
    });
  }
  return sdk;
}

// After a full disconnect the transport is gone; rebuilding the SDK re-runs
// the constructor prewarm so the next connect opens instantly.
export function resetJaw() {
  sdk = null;
  return getJaw();
}

// Constructing the provider prewarms the hidden keys iframe (mount + handshake)
// before the user ever taps a CTA, so the first dialog opens instantly.
export function prewarmJaw() {
  const jaw = getJaw();
  if (!jaw) return null;
  const { provider } = jaw;
  return provider;
}
