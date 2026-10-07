import { createCipheriv, createDecipheriv, createHash, createPrivateKey, hkdfSync, randomBytes } from 'node:crypto';
import type { Hex } from 'viem';

export type Sealed = string & { readonly __brand: 'Sealed' };
export type Wrapped = string & { readonly __brand: 'Wrapped' };

interface RingKey {
  kid: string;
  seal: Buffer;
  jwe: Buffer;
  cookie: string;
}

export interface KeyRing {
  keys: readonly [RingKey, ...RingKey[]];
  /** Signing key for the provider, so it never falls back to its published dev keys. */
  jwk: JsonWebKey;
}

const derive = (raw: Buffer, purpose: string) => Buffer.from(hkdfSync('sha256', raw, '', `jaw-mcp/${purpose}`, 32));

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

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

function encrypt(version: string, kid: string, key: Buffer, privateKey: Hex, id: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(id));
  const body = Buffer.concat([cipher.update(privateKey.slice(2), 'hex'), cipher.final(), cipher.getAuthTag()]);
  return `${version}.${kid}.${iv.toString('base64url')}.${body.toString('base64url')}`;
}

function decrypt(ring: KeyRing, blob: string, expected: string, id: string, keyOf: (k: RingKey) => Buffer): Hex {
  const [version, kid, iv, body] = blob.split('.');
  const key = ring.keys.find((k) => k.kid === kid);
  if (version !== expected || !key || !iv || !body) throw new Error('sealed key cannot be opened');
  const data = Buffer.from(body, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(key), Buffer.from(iv, 'base64url')).setAAD(Buffer.from(id));
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  return `0x${plain.toString('hex')}`;
}

// The connection id is the AAD, so a sealed key cannot move to another connection.
export function seal(ring: KeyRing, privateKey: Hex, id: string): Sealed {
  const { kid, seal: key } = ring.keys[0];
  return encrypt('v1', kid, key, privateKey, id) as Sealed;
}

export function open(ring: KeyRing, sealed: Sealed, id: string): Hex {
  return decrypt(ring, sealed, 'v1', id, (k) => k.seal);
}

// Neither the ring nor the refresh token opens a wrapped key alone, and the
// database stores neither the token nor anything that opens without it.
const wrapKey = (k: RingKey, refreshToken: string) =>
  Buffer.from(hkdfSync('sha256', refreshToken, k.seal, 'jaw-mcp/wrap', 32));

export function wrap(ring: KeyRing, privateKey: Hex, id: string, refreshToken: string): Wrapped {
  const newest = ring.keys[0];
  return encrypt('w1', newest.kid, wrapKey(newest, refreshToken), privateKey, id) as Wrapped;
}

export function unwrap(ring: KeyRing, wrapped: Wrapped, id: string, refreshToken: string): Hex {
  return decrypt(ring, wrapped, 'w1', id, (k) => wrapKey(k, refreshToken));
}
