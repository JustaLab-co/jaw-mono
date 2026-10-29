import { describe, expect, it } from 'vitest';
import { keyProof, parseLinkSecret } from './bridge-proof';

// 32 bytes of 0x07, and its proof for session-1 and public key 04abcd, computed with Node's createHmac.
const SECRET = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const PROOF = '526ecccfc6968475c3e156cba183d7b8cdef3cd7bfc47006538b06a8ee701d23';

describe('keyProof', () => {
  it('matches the vector computed outside this codebase', async () => {
    const secret = parseLinkSecret(SECRET) as Uint8Array;
    expect(await keyProof(secret, 'session-1', '04abcd')).toBe(PROOF);
  });

  it('changes with the session and with the public key', async () => {
    const secret = parseLinkSecret(SECRET) as Uint8Array;
    expect(await keyProof(secret, 'session-2', '04abcd')).not.toBe(PROOF);
    expect(await keyProof(secret, 'session-1', '04abce')).not.toBe(PROOF);
  });
});

describe('parseLinkSecret', () => {
  it('is undefined when the link carries no secret', () => {
    expect(parseLinkSecret(null)).toBeUndefined();
  });

  it('decodes 32 bytes of unpadded base64url', () => {
    expect(parseLinkSecret(SECRET)).toEqual(new Uint8Array(32).fill(7));
  });

  it('decodes the url-safe alphabet', () => {
    const bytes = new Uint8Array(32).fill(0xfb);
    const encoded = Buffer.from(bytes).toString('base64url');
    expect(encoded).toMatch(/[-_]/);
    expect(parseLinkSecret(encoded)).toEqual(bytes);
  });

  it.each([
    ['empty', ''],
    ['too short', 'BwcH'],
    ['too long', SECRET + 'Bwc'],
    ['padded', SECRET + '='],
    ['standard base64 characters', SECRET.slice(0, -1) + '+'],
    ['other characters', SECRET.slice(0, -1) + '!'],
  ])('is invalid when %s', (_, s) => {
    expect(parseLinkSecret(s)).toBe('invalid');
  });
});
