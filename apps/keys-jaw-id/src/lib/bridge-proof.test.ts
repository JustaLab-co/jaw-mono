import { describe, expect, it } from 'vitest';
import { keyProof, readLink } from './bridge-proof';

// 32 bytes of 0x07. The same vector is pinned in jaw-agent's agent package test,
// computed there and here with Node's createHmac.
const SECRET = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const PROOF = '0a5a8276cde5ae4600cb3ba7bb40c1f3718c2ddf26e7ad98d8b8eaf91c9619b4';
const SECRET_BYTES = new Uint8Array(32).fill(7);

describe('keyProof', () => {
  it('matches the vector computed outside this codebase', async () => {
    expect(await keyProof(SECRET_BYTES, 'session-1', '04aaaa', '04abcd')).toBe(PROOF);
  });

  it('changes with the session, the client key and the page key', async () => {
    expect(await keyProof(SECRET_BYTES, 'session-2', '04aaaa', '04abcd')).not.toBe(PROOF);
    expect(await keyProof(SECRET_BYTES, 'session-1', '04aaab', '04abcd')).not.toBe(PROOF);
    expect(await keyProof(SECRET_BYTES, 'session-1', '04aaaa', '04abce')).not.toBe(PROOF);
  });
});

describe('readLink', () => {
  it('reads the key of a link with no secret', () => {
    expect(readLink('pk=04aa')).toEqual({ kind: 'ok', pk: '04aa', secret: undefined });
  });

  it('reads 32 bytes of unpadded base64url', () => {
    expect(readLink(`pk=04aa&s=${SECRET}`)).toEqual({ kind: 'ok', pk: '04aa', secret: SECRET_BYTES });
  });

  it('reads the url-safe alphabet', () => {
    const bytes = new Uint8Array(32).fill(0xfb);
    const encoded = Buffer.from(bytes).toString('base64url');
    expect(encoded).toMatch(/[-_]/);
    expect(readLink(`pk=04aa&s=${encoded}`)).toEqual({ kind: 'ok', pk: '04aa', secret: bytes });
  });

  it('is gone when the link has no key', () => {
    expect(readLink('')).toEqual({ kind: 'gone' });
    expect(readLink(`s=${SECRET}`)).toEqual({ kind: 'gone' });
  });

  it.each([
    ['empty', ''],
    ['too short', 'BwcH'],
    ['too long', SECRET + 'Bwc'],
    ['padded', SECRET + '='],
    ['standard base64 characters', SECRET.slice(0, -1) + '+'],
    ['other characters', SECRET.slice(0, -1) + '!'],
    ['non-canonical trailing bits', SECRET.slice(0, -1) + 'x'],
  ])('is damaged when the secret is %s', (_, s) => {
    expect(readLink(`pk=04aa&s=${encodeURIComponent(s)}`)).toEqual({ kind: 'damaged' });
  });
});
