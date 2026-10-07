import { createCipheriv, createDecipheriv, createHash, createPrivateKey, hkdfSync, randomBytes } from 'node:crypto';
import type { Hex } from 'viem';

/** `v1.<kid>.<iv>.<ciphertext+tag>`, base64url parts. Opaque outside this file. */
export type Sealed = string & { readonly __brand: 'Sealed' };

interface RingKey {
  kid: string;
  seal: Buffer;
  jwe: Buffer;
  cookie: string;
}

/** Newest first: seal and encrypt with [0], open with any. */
export interface KeyRing {
  keys: readonly [RingKey, ...RingKey[]];
  /** Signing key for the provider, so it never falls back to its published dev keys. */
  jwk: JsonWebKey;
}

const derive = (raw: Buffer, purpose: string) => Buffer.from(hkdfSync('sha256', raw, '', `jaw-mcp/${purpose}`, 32));

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Parses JAW_MCP_SEALING_KEYS: comma-separated base64url keys of 32 bytes, newest first. */
export function parseKeyRing(env: string | undefined): KeyRing {
  const raws = (env ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Buffer.from(s, 'base64url'));
  if (raws.length === 0) throw new Error('JAW_MCP_SEALING_KEYS is not set');
  if (raws.some((r) => r.length !== 32)) throw new Error('JAW_MCP_SEALING_KEYS entries must be 32 bytes');
  const keys = raws.map((raw) => {
    const seal = derive(raw, 'seal');
    return {
      kid: createHash('sha256').update(seal).digest('hex').slice(0, 16),
      seal,
      jwe: derive(raw, 'jwe'),
      cookie: derive(raw, 'cookie').toString('base64url'),
    };
  }) as [RingKey, ...RingKey[]];
  const seed = derive(raws[0], 'jwk');
  const jwk = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' }).export({
    format: 'jwk',
  });
  return { keys, jwk };
}

/** AES-256-GCM under the newest key, bound to `id` so a sealed key cannot move to another connection. */
export function seal(ring: KeyRing, privateKey: Hex, id: string): Sealed {
  const { kid, seal: key } = ring.keys[0];
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(id));
  const body = Buffer.concat([cipher.update(privateKey.slice(2), 'hex'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${kid}.${iv.toString('base64url')}.${body.toString('base64url')}` as Sealed;
}

/** Throws on an unknown key, another connection's id, or any tampering. */
export function open(ring: KeyRing, sealed: Sealed, id: string): Hex {
  const [version, kid, iv, body] = sealed.split('.');
  const key = ring.keys.find((k) => k.kid === kid);
  if (version !== 'v1' || !key || !iv || !body) throw new Error('sealed key cannot be opened');
  const data = Buffer.from(body, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key.seal, Buffer.from(iv, 'base64url')).setAAD(Buffer.from(id));
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  return `0x${plain.toString('hex')}`;
}

export function isStale(ring: KeyRing, sealed: Sealed): boolean {
  return sealed.split('.')[1] !== ring.keys[0].kid;
}
