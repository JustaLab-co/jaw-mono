import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownershipChallenge, ownershipProofFromAssertion } from './ownershipProof.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const base64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const bytes = (text: string) => new TextEncoder().encode(text);

function clientData(origin: string) {
    return bytes(JSON.stringify({ type: 'webauthn.get', challenge: 'x', origin }));
}

function assertion(origin = 'https://keys.jaw.id') {
    return {
        id: 'cred-1',
        type: 'public-key',
        response: {
            authenticatorData: bytes('auth-data').buffer,
            clientDataJSON: clientData(origin).buffer,
            signature: bytes('sig').buffer,
        },
    };
}

describe('ownershipChallenge', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('is the passkey update prefix, the time in milliseconds and 16 random bytes in hex, as UTF-8', () => {
        vi.useFakeTimers({ now: new Date('2026-11-27T12:00:00.000Z') });

        const challenge = decode(ownershipChallenge());

        expect(challenge).toMatch(/^jaw\.id\/passkey-update\/v1:1795780800000:[0-9a-f]{32}$/);
    });

    it('differs on every call', () => {
        expect(decode(ownershipChallenge())).not.toBe(decode(ownershipChallenge()));
    });

    it('is longer than 32 bytes, so it can never be taken for the hash a userOp or message signature signs', () => {
        expect(ownershipChallenge().length).toBeGreaterThan(32);
    });
});

describe('ownershipProofFromAssertion', () => {
    it('returns the three signed parts of the assertion, base64url', () => {
        expect(ownershipProofFromAssertion(assertion())).toEqual({
            authenticatorData: base64url('auth-data'),
            clientDataJSON: base64url(
                JSON.stringify({ type: 'webauthn.get', challenge: 'x', origin: 'https://keys.jaw.id' })
            ),
            signature: base64url('sig'),
        });
    });

    it('reads Uint8Array parts the same as ArrayBuffer ones', () => {
        const credential = assertion();
        const response = credential.response;
        const proof = ownershipProofFromAssertion({
            ...credential,
            response: {
                authenticatorData: new Uint8Array(response.authenticatorData),
                clientDataJSON: new Uint8Array(response.clientDataJSON),
                signature: new Uint8Array(response.signature),
            },
        });

        expect(proof).toEqual(ownershipProofFromAssertion(assertion()));
    });

    it.each([
        ['an Android app', 'android:apk-key-hash:abc'],
        ['a page over http', 'http://localhost:3000'],
    ])('gives no proof for an assertion made in %s, which the server cannot verify', (_, origin) => {
        expect(ownershipProofFromAssertion(assertion(origin))).toBeUndefined();
    });

    it.each([
        ['no credential', null],
        ['no response', { id: 'cred-1' }],
        [
            'no signature (a custom getFn)',
            {
                response: {
                    authenticatorData: new ArrayBuffer(37),
                    clientDataJSON: clientData('https://a.example').buffer,
                },
            },
        ],
        [
            'client data that is not JSON',
            {
                response: {
                    authenticatorData: new ArrayBuffer(37),
                    clientDataJSON: bytes('nope').buffer,
                    signature: new ArrayBuffer(8),
                },
            },
        ],
    ])('gives no proof, without throwing, for %s', (_, credential) => {
        expect(ownershipProofFromAssertion(credential)).toBeUndefined();
    });

    it('gives no proof, without throwing, when reading the response is blocked', () => {
        const credential = {
            id: 'cred-1',
            get response(): never {
                throw new Error('Permission denied to access property');
            },
        };

        expect(ownershipProofFromAssertion(credential)).toBeUndefined();
    });
});
