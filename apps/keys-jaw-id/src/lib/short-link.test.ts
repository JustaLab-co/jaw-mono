import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openShortLink } from './short-link';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../app/cli-bridge/fixtures/short-link-current.json'), 'utf8')
) as { shortLink: { id: string; key: string; blob: string }; expect: { opened: Record<string, string> } };
const { id, key, blob } = fixture.shortLink;
const opened = fixture.expect.opened;

const serving = (body: unknown, status = 200) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

const flip = (b64: string, at: number) => {
  const bytes = Buffer.from(b64, 'base64url');
  bytes[at] ^= 1;
  return bytes.toString('base64url');
};

describe('openShortLink', () => {
  it('opens the shared test vector into the session, relay and fragment of the long link', async () => {
    const fetcher = serving({ blob });

    expect(await openShortLink(id, key, fetcher)).toEqual({
      session: opened.session,
      relay: opened.relay,
      fragment: `pk=${opened.pk}&s=${opened.s}`,
    });
    expect(fetcher).toHaveBeenCalledWith(`/api/a/${id}`, { cache: 'no-store' });
  });

  it.each([
    ['a tampered ciphertext', () => serving({ blob: flip(blob, 40) }), key],
    ['a tampered tag', () => serving({ blob: flip(blob, Buffer.from(blob, 'base64url').length - 1) }), key],
    ['a wrong key', () => serving({ blob }), 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM'],
    ['a missing entry', () => serving({}, 404), key],
    ['an error answer that still carries a blob', () => serving({ blob }, 500), key],
    ['a body without a blob', () => serving({}), key],
    ['a blob that is not base64url', () => serving({ blob: '***' }), key],
    ['a blob shorter than its IV and tag', () => serving({ blob: 'AAAA' }), key],
  ])('gives nothing for %s', async (_, fetcher, k) => {
    expect(await openShortLink(id, k, fetcher())).toBeUndefined();
  });

  it('gives nothing for a blob stored under another id', async () => {
    const other = 'BAQEBAQEBAQEBAQEBAQEBA';
    expect(await openShortLink(other, key, serving({ blob }))).toBeUndefined();
  });

  it('gives nothing when the request fails', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await openShortLink(id, key, fetcher)).toBeUndefined();
  });

  it.each([
    ['an empty key', ''],
    ['a short key', 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg'],
    ['a key with padding', 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='],
    ['a key that is not canonical', 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ'],
  ])('gives nothing for %s, without a request', async (_, k) => {
    const fetcher = serving({ blob });
    expect(await openShortLink(id, k, fetcher)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('gives nothing for a bad id, without a request', async () => {
    const fetcher = serving({ blob });
    expect(await openShortLink('../cli-key', key, fetcher)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('openShortLink on a plaintext it did not expect', () => {
  async function sealed(plain: unknown) {
    const iv = new Uint8Array(12).fill(9);
    const k = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['encrypt']);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`jaw-short-link/1\n${id}`) },
      k,
      new TextEncoder().encode(typeof plain === 'string' ? plain : JSON.stringify(plain))
    );
    return Buffer.concat([iv, new Uint8Array(ct)]).toString('base64url');
  }

  it.each([
    ['another version', { ...opened, v: 2 }],
    ['no session', { ...opened, session: undefined }],
    ['a relay that is not a string', { ...opened, relay: 5 }],
    ['no pk', { ...opened, pk: undefined }],
    ['no secret', { ...opened, s: undefined }],
    ['text that is not JSON', 'not json'],
    ['null', null],
  ])('gives nothing for %s', async (_, plain) => {
    expect(await openShortLink(id, key, serving({ blob: await sealed(plain) }))).toBeUndefined();
  });

  it('opens a plaintext it built itself, so the test above seals the way the server does', async () => {
    expect(await openShortLink(id, key, serving({ blob: await sealed(opened) }))).toBeDefined();
  });
});
