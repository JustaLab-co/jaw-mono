export const DEFAULT_BRIDGE_APP_NAME = 'JAW CLI';

const MAX_LENGTH = 64;

// Keep in sync with appNameOf in apps/mcp/src/connections/relay.ts.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * The name a bridge client asks to be shown under, or the CLI default when it
 * sent none. It reaches the owner's screens, so whitespace is flattened,
 * invisible characters are removed and the cap counts code points, matching
 * the hosted server.
 */
export function resolveBridgeAppName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_BRIDGE_APP_NAME;
  const clean = raw.replace(/\s+/g, ' ').replace(UNSEEN, '').replace(/\s+/g, ' ').trim();
  const name = Array.from(clean).slice(0, MAX_LENGTH).join('').trim();
  return name || DEFAULT_BRIDGE_APP_NAME;
}
