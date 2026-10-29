export const KEY_PROOF_LABEL = 'jaw-bridge-key/1';

const SECRET_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The link secret from the fragment's `s`: 32 bytes of base64url, undefined when absent, 'invalid' otherwise. */
export function parseLinkSecret(s: string | null): Uint8Array | undefined | 'invalid' {
  if (s === null) return undefined;
  if (!BASE64URL.test(s)) return 'invalid';
  try {
    const bytes = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    return bytes.length === SECRET_BYTES ? bytes : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Proves the page holds the link secret, which the relay never sees. */
export async function keyProof(secret: Uint8Array, session: string, publicKeyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const message = new TextEncoder().encode(`${KEY_PROOF_LABEL}\n${session}\n${publicKeyHex}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}
