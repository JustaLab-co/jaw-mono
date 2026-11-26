import { afterEach, describe, it, expect, vi } from 'vitest';
import { hkdfSha256, deriveKeyFromPrf, assertPrfLabel } from './derive.js';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe('hkdfSha256', () => {
    it('matches RFC 5869 test case 1', async () => {
        const okm = await hkdfSha256(
            new Uint8Array(22).fill(0x0b),
            fromHex('000102030405060708090a0b0c'),
            fromHex('f0f1f2f3f4f5f6f7f8f9'),
            42
        );
        expect(hex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
    });
});

describe('deriveKeyFromPrf', () => {
    // PRF output 0x00..0x1f. Expected keys computed outside this codebase with
    // Python's hmac/hashlib HKDF (salt "jaw.id/prf/hkdf/v1", info = label). If
    // these fail, the derivation changed and every user's keys with it.
    const PRF_OUTPUT = Uint8Array.from({ length: 32 }, (_, i) => i);

    it('derives the pinned key for a label', async () => {
        const key = await deriveKeyFromPrf(PRF_OUTPUT, 'jaw.id/backup-encryption/v1');
        expect(hex(key)).toBe('31fefa7f439209c3015b2b63794621f36941717fbb7f66d999e43c6148b664b6');
    });

    it('derives a different key when the label version changes', async () => {
        const key = await deriveKeyFromPrf(PRF_OUTPUT, 'jaw.id/backup-encryption/v2');
        expect(hex(key)).toBe('ca0998924fd9b3be870c4fe010b2e6bf059accd19857a4985f10b92bf7715d6d');
    });

    it('is deterministic and does not modify the PRF output', async () => {
        const input = new Uint8Array(PRF_OUTPUT);
        const a = await deriveKeyFromPrf(input, 'jaw.id/backup-encryption/v1');
        const b = await deriveKeyFromPrf(input, 'jaw.id/backup-encryption/v1');
        expect(a).toEqual(b);
        expect(input).toEqual(PRF_OUTPUT);
    });

    it('rejects a PRF output that is not 32 bytes', async () => {
        await expect(deriveKeyFromPrf(new Uint8Array(31), 'jaw.id/x/v1')).rejects.toThrow('must be 32 bytes');
    });
});

describe('hkdfSha256 key material', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('zeroes the copy of the PRF output it hands to WebCrypto', async () => {
        const importKey = vi.spyOn(crypto.subtle, 'importKey');
        const prfOutput = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

        const key = await deriveKeyFromPrf(prfOutput, 'jaw.id/a/v1');

        const handed = importKey.mock.calls[0][1] as Uint8Array;
        expect(handed).not.toBe(prfOutput);
        expect(handed).toEqual(new Uint8Array(32));
        // The caller's array and the derived key are left alone.
        expect(prfOutput[0]).toBe(1);
        expect(key).not.toEqual(new Uint8Array(32));
    });

    it('zeroes that copy when the import fails too', async () => {
        const importKey = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('import failed'));

        await expect(deriveKeyFromPrf(new Uint8Array(32).fill(5), 'jaw.id/a/v1')).rejects.toThrow('import failed');

        expect(importKey.mock.calls[0][1]).toEqual(new Uint8Array(32));
    });
});

describe('assertPrfLabel', () => {
    it.each(['jaw.id/backup-encryption/v1', 'jaw.id/privacy-pools/root/v12', 'jaw.id/a/v1'])('accepts %s', (label) => {
        expect(() => assertPrfLabel(label)).not.toThrow();
    });

    it.each([
        'backup-encryption/v1', // no jaw.id prefix
        'jaw.id/backup-encryption', // no version
        'jaw.id/v1', // no use
        'jaw.id/backup-encryption/v0', // version starts at 1
        'jaw.id/Backup/v1', // uppercase
        'jaw.id/backup encryption/v1', // space
        'jaw.id//v1', // empty segment
        'xjaw.id/a/v1', // text before jaw.id/
        'jaw.id/a/v1x', // text after the version
        'jaw.id/a/v1/', // trailing slash
        '',
    ])('rejects %j', (label) => {
        expect(() => assertPrfLabel(label)).toThrow('Invalid PRF key label');
    });
});
