import { afterEach, describe, it, expect, vi } from 'vitest';
import { evaluatePrf, PrfUnavailableError, PRF_SALT_V1 } from './evaluate.js';
import { WebAuthnAuthenticationError } from '../passkey-manager/utils.js';

const CREDENTIAL_ID = 'AQIDBA'; // base64url of 01 02 03 04

function credentialWith(extensionResults: unknown, id = CREDENTIAL_ID) {
    return { id, type: 'public-key', getClientExtensionResults: () => extensionResults };
}

const prfResult = (bytes: Uint8Array) => ({ prf: { results: { first: bytes.buffer } } });

describe('evaluatePrf', () => {
    it('asks only the account passkey, requires user verification, and sends the fixed salt', async () => {
        const getFn = vi.fn().mockResolvedValue(credentialWith(prfResult(new Uint8Array(32).fill(7))));

        await evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn });

        const { publicKey } = getFn.mock.calls[0][0];
        expect(publicKey.rpId).toBe('keys.jaw.id');
        expect(publicKey.userVerification).toBe('required');
        expect(publicKey.allowCredentials).toHaveLength(1);
        expect(Array.from(publicKey.allowCredentials[0].id)).toEqual([1, 2, 3, 4]);
        expect(new TextDecoder().decode(publicKey.extensions.prf.eval.first)).toBe('jaw.id/prf/salt/v1');
        expect(PRF_SALT_V1).toBe('jaw.id/prf/salt/v1');
        // The challenge doubles as a passkey update proof, so recording PRF support needs no second prompt.
        expect(new TextDecoder().decode(publicKey.challenge)).toMatch(
            /^jaw\.id\/passkey-update\/v1:\d{13}:[0-9a-f]{32}$/
        );
    });

    it('returns the 32-byte PRF output and clears the copy it was handed', async () => {
        const fromAuthenticator = new Uint8Array(32).fill(7);
        const getFn = vi.fn().mockResolvedValue(credentialWith(prfResult(fromAuthenticator)));

        const { output } = await evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn });

        expect(output).toEqual(new Uint8Array(32).fill(7));
        expect(fromAuthenticator.every((b) => b === 0)).toBe(true);
    });

    it.each([
        ['no extension results', undefined],
        ['no prf result', {}],
        ['prf without results', { prf: { enabled: true } }],
    ])('throws PrfUnavailableError with %s', async (_, results) => {
        const getFn = vi.fn().mockResolvedValue(credentialWith(results));
        await expect(evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn })).rejects.toThrow(
            PrfUnavailableError
        );
    });

    it('throws PrfUnavailableError on an output that is not 32 bytes', async () => {
        const getFn = vi.fn().mockResolvedValue(credentialWith(prfResult(new Uint8Array(16))));
        await expect(evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn })).rejects.toThrow(
            PrfUnavailableError
        );
    });

    it('refuses an answer from a different passkey', async () => {
        const getFn = vi.fn().mockResolvedValue(credentialWith(prfResult(new Uint8Array(32)), 'other-cred'));
        await expect(evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn })).rejects.toThrow(
            'A different passkey answered'
        );
    });

    it('throws WebAuthnAuthenticationError when the prompt is cancelled', async () => {
        const getFn = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
        await expect(evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn })).rejects.toThrow(
            WebAuthnAuthenticationError
        );
    });

    it('throws WebAuthnAuthenticationError when no credential comes back', async () => {
        const getFn = vi.fn().mockResolvedValue(null);
        await expect(evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn })).rejects.toThrow(
            WebAuthnAuthenticationError
        );
    });

    describe('in the browser, without getFn (the path keys.jaw.id uses)', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('asks navigator.credentials for the account passkey and returns its PRF output', async () => {
            const get = vi.fn().mockResolvedValue(credentialWith(prfResult(new Uint8Array(32).fill(9))));
            vi.stubGlobal('window', { PublicKeyCredential: vi.fn() });
            vi.stubGlobal('navigator', { credentials: { get } });

            const { output } = await evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID });

            expect(output).toEqual(new Uint8Array(32).fill(9));
            expect(get).toHaveBeenCalledTimes(1);
            const { publicKey } = get.mock.calls[0][0];
            expect(publicKey.rpId).toBe('keys.jaw.id');
            expect(publicKey.userVerification).toBe('required');
            expect(publicKey.allowCredentials).toHaveLength(1);
            expect(Array.from(publicKey.allowCredentials[0].id)).toEqual([1, 2, 3, 4]);
            expect(new TextDecoder().decode(publicKey.extensions.prf.eval.first)).toBe(PRF_SALT_V1);
        });
    });

    it('throws when WebAuthn is unavailable and no getFn is given', async () => {
        await expect(evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID })).rejects.toThrow(
            'WebAuthn is not supported'
        );
    });

    describe('the ownership proof (no extra prompt)', () => {
        const text = (value: string) => new TextEncoder().encode(value);

        function signedCredential(extensionResults: unknown) {
            return {
                ...credentialWith(extensionResults),
                response: {
                    authenticatorData: text('auth-data').buffer,
                    clientDataJSON: text(JSON.stringify({ type: 'webauthn.get', origin: 'https://keys.jaw.id' }))
                        .buffer,
                    signature: text('sig').buffer,
                },
            };
        }

        it('returns the assertion of the PRF prompt as the proof, next to the output', async () => {
            const getFn = vi.fn().mockResolvedValue(signedCredential(prfResult(new Uint8Array(32).fill(7))));

            const { proof } = await evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn });

            expect(getFn).toHaveBeenCalledTimes(1);
            expect(proof).toEqual({
                authenticatorData: 'YXV0aC1kYXRh',
                clientDataJSON: expect.any(String),
                signature: 'c2ln',
            });
        });

        it('carries the proof on PrfUnavailableError, so a passkey without PRF can still be recorded', async () => {
            const getFn = vi.fn().mockResolvedValue(signedCredential({}));

            const error = await evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn }).catch(
                (caught: unknown) => caught
            );

            expect(error).toBeInstanceOf(PrfUnavailableError);
            expect((error as PrfUnavailableError).proof).toEqual({
                authenticatorData: 'YXV0aC1kYXRh',
                clientDataJSON: expect.any(String),
                signature: 'c2ln',
            });
        });

        it('gives no proof when the answer carries no signature', async () => {
            const getFn = vi.fn().mockResolvedValue(credentialWith(prfResult(new Uint8Array(32))));

            const { proof } = await evaluatePrf({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn });

            expect(proof).toBeUndefined();
        });
    });
});
