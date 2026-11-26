import { describe, it, expect } from 'vitest';
import {
    parseAuthenticatorData,
    authDataFromAttestationObject,
    readAuthenticatorInfo,
    readAssertionAuthenticatorInfo,
} from './authenticatorData.js';

// Fixtures are assembled from the WebAuthn spec layout (§6.1 authenticator data,
// §6.5 attestation object), not from the parser under test.

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

/** Google Password Manager's AAGUID. */
const GPM_AAGUID = 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4';
const GPM_AAGUID_BYTES = [
    0xea, 0x9b, 0x8d, 0x66, 0x4d, 0x01, 0x1d, 0x21, 0x3c, 0xe4, 0xb6, 0xb4, 0x8c, 0xb5, 0x75, 0xd4,
];

function authData(flags: number, aaguid: number[] = GPM_AAGUID_BYTES): Uint8Array {
    const bytes = [
        ...new Array(32).fill(0x11), // rpIdHash
        flags,
        0x00,
        0x00,
        0x00,
        0x00, // signCount
    ];
    if (flags & FLAG_AT) {
        bytes.push(
            ...aaguid,
            0x00,
            0x04, // credentialIdLength
            0xc1,
            0xc2,
            0xc3,
            0xc4, // credentialId
            0xa1,
            0x01,
            0x02 // COSE key stub: {1: 2}
        );
    }
    return new Uint8Array(bytes);
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** CBOR map {fmt, attStmt, authData} with `authData` last, as authenticators order it. */
function attestationObject(data: Uint8Array, attStmt: number[] = [0xa0]): Uint8Array {
    return new Uint8Array([
        0xa3, // map(3)
        0x63,
        ...ascii('fmt'),
        0x66,
        ...ascii('packed'),
        0x67,
        ...ascii('attStmt'),
        ...attStmt,
        0x68,
        ...ascii('authData'),
        0x58,
        data.length, // bytes(n), n < 256
        ...data,
    ]);
}

describe('parseAuthenticatorData', () => {
    it('reads a synced passkey: both backup flags set and the AAGUID as a UUID', () => {
        const info = parseAuthenticatorData(authData(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT));
        expect(info).toEqual({ backupEligible: true, backupState: true, aaguid: GPM_AAGUID });
    });

    it('reads a device-bound passkey: neither backup flag set', () => {
        const info = parseAuthenticatorData(authData(FLAG_UP | FLAG_UV | FLAG_AT));
        expect(info.backupEligible).toBe(false);
        expect(info.backupState).toBe(false);
    });

    it('reads backup-eligible but not yet backed up', () => {
        const info = parseAuthenticatorData(authData(FLAG_UP | FLAG_BE | FLAG_AT));
        expect(info.backupEligible).toBe(true);
        expect(info.backupState).toBe(false);
    });

    it('keeps an AAGUID that contains zero bytes, such as Chrome profile passkeys', () => {
        // adce0002-35bc-c60a-648b-0b25f1f05503: only an all-zero AAGUID means unknown.
        const chromeProfile = [
            0xad, 0xce, 0x00, 0x02, 0x35, 0xbc, 0xc6, 0x0a, 0x64, 0x8b, 0x0b, 0x25, 0xf1, 0xf0, 0x55, 0x03,
        ];
        const info = parseAuthenticatorData(authData(FLAG_UP | FLAG_AT, chromeProfile));
        expect(info.aaguid).toBe('adce0002-35bc-c60a-648b-0b25f1f05503');
    });

    it('leaves the AAGUID unknown when the platform zeroed it', () => {
        const info = parseAuthenticatorData(authData(FLAG_UP | FLAG_AT, new Array(16).fill(0)));
        expect(info.aaguid).toBeUndefined();
        expect('aaguid' in info).toBe(false);
    });

    it('has no AAGUID when attested credential data is absent', () => {
        const info = parseAuthenticatorData(authData(FLAG_UP | FLAG_BE));
        expect(info).toEqual({ backupEligible: true, backupState: false });
    });

    it('throws on data shorter than the fixed header', () => {
        expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow('too short');
    });

    it('throws when the AT flag is set but the AAGUID is cut off', () => {
        expect(() => parseAuthenticatorData(authData(FLAG_AT).slice(0, 40))).toThrow('too short for AAGUID');
    });
});

describe('authDataFromAttestationObject', () => {
    it('returns the authData byte string', () => {
        const data = authData(FLAG_UP | FLAG_BE | FLAG_BS | FLAG_AT);
        expect(authDataFromAttestationObject(attestationObject(data))).toEqual(data);
    });

    it('walks past an attStmt that contains the text "authData" inside its signature', () => {
        const data = authData(FLAG_UP | FLAG_AT);
        const decoy = [0x68, ...ascii('authData'), 0x41, 0x00];
        const attStmt = [
            0xa2, // map(2)
            0x63,
            ...ascii('alg'),
            0x26, // -7
            0x63,
            ...ascii('sig'),
            0x58,
            decoy.length, // bytes(n)
            ...decoy,
        ];
        expect(authDataFromAttestationObject(attestationObject(data, attStmt))).toEqual(data);
    });

    it('reads authData whose length needs a two-byte CBOR header', () => {
        const data = new Uint8Array(300).fill(0x22);
        const obj = new Uint8Array([
            0xa1, // map(1)
            0x68,
            ...ascii('authData'),
            0x59,
            0x01,
            0x2c, // bytes(300)
            ...data,
        ]);
        expect(authDataFromAttestationObject(obj)).toEqual(data);
    });

    it('throws when the input is not a CBOR map', () => {
        expect(() => authDataFromAttestationObject(new Uint8Array([0x01, 0x02]))).toThrow('not a CBOR map');
    });

    it('throws when there is no authData key', () => {
        const obj = new Uint8Array([0xa1, 0x63, ...ascii('fmt'), 0x64, ...ascii('none')]);
        expect(() => authDataFromAttestationObject(obj)).toThrow('no authData');
    });

    it('throws when the object is truncated', () => {
        const obj = attestationObject(authData(FLAG_AT));
        expect(() => authDataFromAttestationObject(obj.slice(0, obj.length - 10))).toThrow('truncated');
    });
});

// Input from an authenticator or a browser extension can be anything. Each case
// must fail fast with an error (never hang, never allocate what the header claims),
// and readAuthenticatorInfo must still return, keeping what it can.
describe('authDataFromAttestationObject on hostile input', () => {
    const text = (value: string) => [0x60 + value.length, ...new TextEncoder().encode(value)];
    const EIGHT_BYTE_MAX = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    // A value nested 100,000 arrays deep under "fmt", before any authData.
    const deeplyNested = [0xa1, ...text('fmt'), ...new Array(100_000).fill(0x81), 0x00];

    it.each([
        ['empty input', [], /truncated/],
        ['a map claiming 2^64 entries', [0xbb, ...EIGHT_BYTE_MAX], /truncated/],
        ['a skipped array claiming 2^64 items', [0xa1, ...text('fmt'), 0x9b, ...EIGHT_BYTE_MAX], /truncated/],
        ['a key with an 8-byte length', [0xa1, 0x7b, ...EIGHT_BYTE_MAX], /truncated/],
        ['authData with an 8-byte length', [0xa1, ...text('authData'), 0x5b, ...EIGHT_BYTE_MAX], /truncated/],
        ['an indefinite-length map', [0xbf, 0xff], /Unsupported CBOR additional info/],
        // Recursion ends in either a stack overflow or a missing authData; both throw.
        ['deep nesting', deeplyNested, /.+/],
    ])('throws on %s, and readAuthenticatorInfo keeps only the PRF result', (_, bytes, error) => {
        const input = Uint8Array.from(bytes);

        expect(() => authDataFromAttestationObject(input)).toThrow(error);
        expect(readAuthenticatorInfo(input, { prf: { enabled: true } })).toEqual({ prfSupported: true });
    });
});

describe('readAuthenticatorInfo', () => {
    const synced = attestationObject(authData(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT));

    it('combines PRF support with what the authenticator data says', () => {
        expect(readAuthenticatorInfo(synced, { prf: { enabled: true } })).toEqual({
            prfSupported: true,
            aaguid: GPM_AAGUID,
            backupEligible: true,
            backupState: true,
        });
    });

    it('records an explicit "no PRF" as false', () => {
        expect(readAuthenticatorInfo(synced, { prf: { enabled: false } }).prfSupported).toBe(false);
    });

    it('leaves PRF support unknown when the client returns no prf result', () => {
        expect('prfSupported' in readAuthenticatorInfo(synced, {})).toBe(false);
        expect('prfSupported' in readAuthenticatorInfo(synced, { prf: {} })).toBe(false);
        expect('prfSupported' in readAuthenticatorInfo(synced, undefined)).toBe(false);
    });

    it('does not throw on an unreadable attestation object, keeping what it can', () => {
        expect(readAuthenticatorInfo(new Uint8Array([0x01, 0x02, 0x03]), { prf: { enabled: true } })).toEqual({
            prfSupported: true,
        });
    });

    it('returns nothing when given nothing', () => {
        expect(readAuthenticatorInfo(undefined, undefined)).toEqual({});
    });
});

describe('readAssertionAuthenticatorInfo', () => {
    it('reads the backup flags from login authenticator data, which has no AAGUID', () => {
        expect(readAssertionAuthenticatorInfo(authData(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS))).toEqual({
            backupEligible: true,
            backupState: true,
        });
        expect(readAssertionAuthenticatorInfo(authData(FLAG_UP | FLAG_UV))).toEqual({
            backupEligible: false,
            backupState: false,
        });
    });

    it('never reports an AAGUID or PRF support', () => {
        const info = readAssertionAuthenticatorInfo(authData(FLAG_UP | FLAG_BE | FLAG_AT));
        expect('aaguid' in info).toBe(false);
        expect('prfSupported' in info).toBe(false);
    });

    it('gives nothing for missing or unreadable data', () => {
        expect(readAssertionAuthenticatorInfo(undefined)).toEqual({});
        expect(readAssertionAuthenticatorInfo(new Uint8Array(10))).toEqual({});
    });
});
