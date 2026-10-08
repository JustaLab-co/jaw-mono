// Core's `buildChainConfig` and the paymaster url concatenate the key into a
// query string, and the agent's RPC reads send it as a header. One rule for both.
export { isSafeApiKey } from '@jaw.id/agent';

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
