import { decrypt, encrypt, type JAW } from '@jaw.id/core';
import { sameAccount } from './bridge-session';

/**
 * What a page on a relay session does with each frame: the encrypted envelope, the answers it gives a request, and
 * the relay's own codes, kept apart from any one page.
 */

/** Base64 encode a Uint8Array or ArrayBuffer */
function toBase64(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Base64 decode to Uint8Array */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptAndSerialize(
  sharedSecret: CryptoKey,
  payload: Record<string, unknown>
): Promise<{ type: 'encrypted'; iv: string; ciphertext: string }> {
  const { iv, cipherText } = await encrypt(sharedSecret, JSON.stringify(payload));
  return {
    type: 'encrypted',
    iv: toBase64(iv),
    ciphertext: toBase64(cipherText),
  };
}

export async function deserializeAndDecrypt(
  sharedSecret: CryptoKey,
  msg: { iv: string; ciphertext: string }
): Promise<Record<string, unknown>> {
  const iv = fromBase64(msg.iv);
  const cipherText = fromBase64(msg.ciphertext);
  const plaintext = await decrypt(sharedSecret, { iv, cipherText: cipherText.buffer as ArrayBuffer });
  return JSON.parse(plaintext);
}

// The relay keeps one browser per session and closes the older socket with
// this code when the link is opened in another tab.
export const REPLACED_BY_ANOTHER_TAB = 4003;

// A live server sends init as soon as the key exchange reaches it.
export const SERVER_WAIT_MS = 20_000;

/** JSON with object keys sorted, so a request rebuilt from storage in another key order is still the same request. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function reportBridgeClient(client: string) {
  try {
    fetch('/api/bridge-client', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client }),
    }).catch(() => undefined);
  } catch {
    // The count is optional; the bridge carries on without it.
  }
}

export type RpcResponse = Record<string, unknown> & { type: 'rpc_response'; id: string };

export async function ask(
  sdk: ReturnType<typeof JAW.create>,
  id: string,
  method: string,
  params: unknown[],
  expected?: string
): Promise<RpcResponse> {
  try {
    const result = await sdk.provider.request({ method, params });
    const address = extractAddress(method, result);
    if (expected && address && !sameAccount(address, expected)) {
      const message = `This wallet is signed in as ${address}. The request is for ${expected}.`;
      return { type: 'rpc_response', id, success: false, error: { code: -32000, message } };
    }
    return { type: 'rpc_response', id, success: true, data: result, ...(address ? { address } : {}) };
  } catch (err) {
    const errObj = err as { code?: number; message?: string };
    const code = errObj?.code ?? -32000;
    const message = errObj?.message ?? (err instanceof Error ? err.message : String(err));
    return { type: 'rpc_response', id, success: false, error: { code, message } };
  }
}

/** An id already answered for another request is refused, so an answer never covers a request it was not given for. */
export const idReused = (id: string): RpcResponse => ({
  type: 'rpc_response',
  id,
  success: false,
  error: { code: -32600, message: 'this request id was already used for a different request' },
});

function extractAddress(method: string, result: unknown): string | undefined {
  if (method !== 'wallet_connect' && method !== 'eth_requestAccounts') return;

  if (Array.isArray(result) && typeof result[0] === 'string') {
    return result[0];
  }
  if (result && typeof result === 'object' && 'accounts' in result) {
    const accounts = (result as Record<string, unknown>).accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const first = accounts[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object' && 'address' in first) {
        return (first as Record<string, unknown>).address as string;
      }
    }
  }
  return undefined;
}
