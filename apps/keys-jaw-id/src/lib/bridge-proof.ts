const KEY_PROOF_LABEL = 'jaw-bridge-key/1';
const SECRET_BYTES = 32;

export type BridgeLink = { kind: 'ok'; pk: string; secret?: Uint8Array } | { kind: 'damaged' } | { kind: 'gone' };

/** Reads a link fragment: the client key `pk` and the optional secret `s`, 32 bytes of canonical unpadded base64url. */
export function readLink(hash: string): BridgeLink {
  const params = new URLSearchParams(hash);
  const s = params.get('s');
  let secret: Uint8Array | undefined;
  if (s !== null) {
    secret = decodeSecret(s);
    if (!secret) return { kind: 'damaged' };
  }
  const pk = params.get('pk');
  return pk ? { kind: 'ok', pk, secret } : { kind: 'gone' };
}

function decodeSecret(s: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    if (bytes.length !== SECRET_BYTES) return undefined;
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return canonical === s ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Proves the page holds the link secret, which the relay never sees, for this session and both keys. */
export async function keyProof(
  secret: Uint8Array,
  session: string,
  clientPublicKeyHex: string,
  pagePublicKeyHex: string
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const message = new TextEncoder().encode(
    `${KEY_PROOF_LABEL}\n${session}\n${clientPublicKeyHex}\n${pagePublicKeyHex}`
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}
