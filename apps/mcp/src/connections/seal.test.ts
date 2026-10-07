import { randomBytes } from 'node:crypto';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { isStale, open, parseKeyRing, seal } from './seal';

const key = () => randomBytes(32).toString('base64url');

describe('sealing key ring', () => {
  const [a, b] = [key(), key()];
  const pk = generatePrivateKey();

  it('round trips and never shows the key in the sealed form', () => {
    const ring = parseKeyRing(a);
    const sealed = seal(ring, pk, 'conn_1');
    expect(sealed).not.toContain(pk.slice(2));
    expect(sealed).not.toContain(Buffer.from(pk.slice(2), 'hex').toString('base64url'));
    expect(open(ring, sealed, 'conn_1')).toBe(pk);
  });

  it('opens with an older key after rotation and seals with the new one', () => {
    const before = seal(parseKeyRing(a), pk, 'conn_1');
    const rotated = parseKeyRing(`${b},${a}`);
    expect(open(rotated, before, 'conn_1')).toBe(pk);
    expect(isStale(rotated, before)).toBe(true);
    const after = seal(rotated, pk, 'conn_1');
    expect(isStale(rotated, after)).toBe(false);
    expect(() => open(parseKeyRing(a), after, 'conn_1')).toThrow('cannot be opened');
  });

  it('refuses once the sealing key leaves the ring', () => {
    const sealed = seal(parseKeyRing(a), pk, 'conn_1');
    expect(() => open(parseKeyRing(b), sealed, 'conn_1')).toThrow('cannot be opened');
  });

  it('refuses another connection id and a tampered blob', () => {
    const ring = parseKeyRing(a);
    const sealed = seal(ring, pk, 'conn_1');
    expect(() => open(ring, sealed, 'conn_2')).toThrow();
    const last = sealed.at(-1) === 'A' ? 'B' : 'A';
    expect(() => open(ring, (sealed.slice(0, -1) + last) as typeof sealed, 'conn_1')).toThrow();
  });

  it('rejects a missing or short key list', () => {
    expect(() => parseKeyRing(undefined)).toThrow('not set');
    expect(() => parseKeyRing(randomBytes(16).toString('base64url'))).toThrow('32 bytes');
  });

  it('derives distinct keys per purpose and a stable signing key', () => {
    const ring = parseKeyRing(a);
    const [k] = ring.keys;
    expect(k.jwe.equals(k.seal)).toBe(false);
    expect(parseKeyRing(a).jwk).toEqual(ring.jwk);
    expect(ring.jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
  });
});
