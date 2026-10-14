export const DEFAULT_BRIDGE_APP_NAME = 'JAW CLI';

const MAX_LENGTH = 64;

/**
 * The name a bridge client asks to be shown under, or the CLI default when it
 * sent none. It reaches the owner's screens, so control and bidi characters
 * are dropped and whitespace is flattened before it is used.
 */
export function resolveBridgeAppName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_BRIDGE_APP_NAME;
  const name = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LENGTH)
    .trim();
  return name || DEFAULT_BRIDGE_APP_NAME;
}
