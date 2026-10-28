import { sanitizeBridgeAppName } from '@jaw.id/core';

export const DEFAULT_BRIDGE_APP_NAME = 'JAW CLI';

/** The name a bridge client asks to be shown under, or the CLI default when it sent none. */
export function resolveBridgeAppName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_BRIDGE_APP_NAME;
  return sanitizeBridgeAppName(raw) || DEFAULT_BRIDGE_APP_NAME;
}
