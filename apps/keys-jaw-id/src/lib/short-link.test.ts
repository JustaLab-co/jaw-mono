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

describe('openShortLink on a batch', () => {
  const account = '0x1111111111111111111111111111111111111111';
  const member = (n: number, chainId: number) => ({ id: `${String.fromCharCode(65 + n)}`.repeat(22), key, chainId });
  const batch = { v: 2, account, members: [member(0, 84532), member(1, 11155111), member(2, 11155420)] };

  async function sealed(plain: unknown) {
    const iv = new Uint8Array(12).fill(9);
    const k = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['encrypt']);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`jaw-short-link/1\n${id}`) },
      k,
      new TextEncoder().encode(JSON.stringify(plain))
    );
    return Buffer.concat([iv, new Uint8Array(ct)]).toString('base64url');
  }
  const open = async (plain: unknown) => openShortLink(id, key, serving({ blob: await sealed(plain) }));

  it('opens the account and the members, each with its short link and chain', async () => {
    expect(await open(batch)).toEqual({ account, members: batch.members });
  });

  it('opens five members, the account cap', async () => {
    const five = [84532, 11155111, 11155420, 421614, 80002].map((c, n) => member(n, c));
    expect(await open({ ...batch, members: five })).toEqual({ account, members: five });
  });

  it('keeps only the fields of a member it knows', async () => {
    const extra = { ...member(0, 84532), session: 'not-from-here' };
    expect(await open({ ...batch, members: [extra] })).toEqual({ account, members: [member(0, 84532)] });
  });

  it.each([
    ['no members', { ...batch, members: [] }],
    ['six members', { ...batch, members: [1, 2, 3, 4, 5, 6].map((c, n) => member(n, c)) }],
    ['members that are not a list', { ...batch, members: {} }],
    ['two members on one chain', { ...batch, members: [member(0, 84532), member(1, 84532)] }],
    ['one member twice', { ...batch, members: [member(0, 84532), member(0, 11155111)] }],
    ['a member with a bad id', { ...batch, members: [{ ...member(0, 84532), id: '../cli-key' }] }],
    ['a member with a bad key', { ...batch, members: [{ ...member(0, 84532), key: 'AAAA' }] }],
    [
      'a member whose key is not canonical',
      { ...batch, members: [{ ...member(0, 84532), key: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ' }] },
    ],
    ['a member that names the batch itself', { ...batch, members: [{ ...member(0, 84532), id }] }],
    ['a member with a chain that is not an integer', { ...batch, members: [{ ...member(0, 84532), chainId: 1.5 }] }],
    ['a member with a chain given as text', { ...batch, members: [{ ...member(0, 84532), chainId: '84532' }] }],
    ['a member on chain 0', { ...batch, members: [{ ...member(0, 84532), chainId: 0 }] }],
    ['a member with no chain', { ...batch, members: [{ ...member(0, 84532), chainId: undefined }] }],
    ['a member that is not an object', { ...batch, members: ['x'] }],
    ['no account', { ...batch, account: undefined }],
    ['an account that is not an address', { ...batch, account: '0x1234' }],
    ['another version', { ...batch, v: 3 }],
  ])('gives nothing for %s', async (_, plain) => {
    expect(await open(plain)).toBeUndefined();
  });
});
