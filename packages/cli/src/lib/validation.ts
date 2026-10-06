/**
 * Whether an api key is safe to interpolate into a URL, which is how every
 * consumer of one uses it: `x402/balance.ts` and core's `buildChainConfig` both
 * concatenate it into a query string without encoding.
 *
 * Expressed as a property rather than a guessed alphabet, because the key's
 * real format is the backend's to define and this does not need to know it. A
 * value that survives `encodeURIComponent` unchanged cannot carry an `&`, a `#`
 * or a space, which is what it would take to rewrite the query around it.
 */
export function isSafeApiKey(value: string): boolean {
  return value.length > 0 && encodeURIComponent(value) === value;
}

export function isValidKeysUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isTrustedHost =
      parsed.hostname.endsWith('.jaw.id') ||
      parsed.hostname === 'jaw.id' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1';
    const isSecure = parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return isTrustedHost && isSecure;
  } catch {
    return false;
  }
}

export function isValidRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isTrustedHost =
      parsed.hostname.endsWith('.jaw.id') ||
      parsed.hostname === 'jaw.id' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1';
    const isSecure = parsed.protocol === 'wss:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    const isWebSocket = parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
    return isTrustedHost && isSecure && isWebSocket;
  } catch {
    return false;
  }
}
