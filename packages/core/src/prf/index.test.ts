import { beforeEach, describe, it, expect, vi } from 'vitest';
import { derivePrfKeys, PrfUnavailableError } from './index.js';
import { deriveKeyFromPrf } from './derive.js';

// A pass-through spy: keys are still derived by the real HKDF, and the tests
// can read the PRF output array it was given after derivePrfKeys returns.
vi.mock('./derive.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./derive.js')>();
    return { ...actual, deriveKeyFromPrf: vi.fn(actual.deriveKeyFromPrf) };
});

const CREDENTIAL_ID = 'AQIDBA';
const PRF_OUTPUT = Uint8Array.from({ length: 32 }, (_, i) => i);

function getFnReturning(prf: Uint8Array | undefined) {
    return vi.fn().mockResolvedValue({
        id: CREDENTIAL_ID,
        type: 'public-key',
        getClientExtensionResults: () => (prf ? { prf: { results: { first: prf.buffer } } } : {}),
    });
}

describe('derivePrfKeys', () => {
    beforeEach(() => {
        vi.mocked(deriveKeyFromPrf).mockClear();
    });

    it('prompts once and derives one key per label', async () => {
        const getFn = getFnReturning(new Uint8Array(PRF_OUTPUT));
        const labels = ['jaw.id/backup-encryption/v1', 'jaw.id/privacy-pools/root/v1'] as const;

        const { keys } = await derivePrfKeys({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn }, labels);

        expect(getFn).toHaveBeenCalledTimes(1);
        expect(Object.keys(keys)).toEqual([...labels]);
        expect(keys['jaw.id/backup-encryption/v1']).toEqual(
            await deriveKeyFromPrf(PRF_OUTPUT, 'jaw.id/backup-encryption/v1')
        );
        expect(keys['jaw.id/privacy-pools/root/v1']).toEqual(
            await deriveKeyFromPrf(PRF_OUTPUT, 'jaw.id/privacy-pools/root/v1')
        );
        expect(keys['jaw.id/backup-encryption/v1']).not.toEqual(keys['jaw.id/privacy-pools/root/v1']);
    });

    it('never returns the PRF output itself', async () => {
        const { keys } = await derivePrfKeys(
            { rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn: getFnReturning(new Uint8Array(PRF_OUTPUT)) },
            ['jaw.id/backup-encryption/v1']
        );
        for (const key of Object.values(keys)) expect(key).not.toEqual(PRF_OUTPUT);
    });

    it('checks every label before showing a prompt', async () => {
        const getFn = getFnReturning(new Uint8Array(PRF_OUTPUT));
        await expect(
            derivePrfKeys({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn }, [
                'jaw.id/backup-encryption/v1',
                'unversioned',
            ])
        ).rejects.toThrow('Invalid PRF key label');
        expect(getFn).not.toHaveBeenCalled();
    });

    it('requires at least one label', async () => {
        const getFn = getFnReturning(new Uint8Array(PRF_OUTPUT));
        await expect(derivePrfKeys({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn }, [])).rejects.toThrow(
            'At least one key label'
        );
        expect(getFn).not.toHaveBeenCalled();
    });

    it('passes on PrfUnavailableError so keys can offer the fallback', async () => {
        await expect(
            derivePrfKeys({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn: getFnReturning(undefined) }, [
                'jaw.id/backup-encryption/v1',
            ])
        ).rejects.toThrow(PrfUnavailableError);
    });

    it('zeroes the PRF output once the keys are derived', async () => {
        const { keys } = await derivePrfKeys(
            { rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn: getFnReturning(new Uint8Array(PRF_OUTPUT)) },
            ['jaw.id/backup-encryption/v1', 'jaw.id/privacy-pools/root/v1']
        );

        const received = vi.mocked(deriveKeyFromPrf).mock.calls.map(([prfOutput]) => prfOutput);
        expect(received).toHaveLength(2);
        for (const prfOutput of received) expect(prfOutput).toEqual(new Uint8Array(32));
        // The keys themselves are left for the caller.
        expect(keys['jaw.id/backup-encryption/v1']).not.toEqual(new Uint8Array(32));
    });

    it('zeroes the PRF output and the keys already derived when a later key fails', async () => {
        const actual = await vi.importActual<typeof import('./derive.js')>('./derive.js');
        vi.mocked(deriveKeyFromPrf)
            .mockImplementationOnce(actual.deriveKeyFromPrf)
            .mockRejectedValueOnce(new Error('derive failed'));

        await expect(
            derivePrfKeys(
                {
                    rpId: 'keys.jaw.id',
                    credentialId: CREDENTIAL_ID,
                    getFn: getFnReturning(new Uint8Array(PRF_OUTPUT)),
                },
                ['jaw.id/backup-encryption/v1', 'jaw.id/privacy-pools/root/v1']
            )
        ).rejects.toThrow('derive failed');

        const [[prfOutput]] = vi.mocked(deriveKeyFromPrf).mock.calls;
        expect(prfOutput).toEqual(new Uint8Array(32));
        const firstKey = await vi.mocked(deriveKeyFromPrf).mock.results[0].value;
        expect(firstKey).toEqual(new Uint8Array(32));
    });

    it('returns the proof of the one PRF prompt next to the keys', async () => {
        const text = (value: string) => new TextEncoder().encode(value);
        const getFn = vi.fn().mockResolvedValue({
            id: CREDENTIAL_ID,
            type: 'public-key',
            getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(PRF_OUTPUT).buffer } } }),
            response: {
                authenticatorData: text('auth-data').buffer,
                clientDataJSON: text(JSON.stringify({ type: 'webauthn.get', origin: 'https://keys.jaw.id' })).buffer,
                signature: text('sig').buffer,
            },
        });

        const { proof } = await derivePrfKeys({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn }, [
            'jaw.id/backup-encryption/v1',
        ]);

        expect(getFn).toHaveBeenCalledTimes(1);
        expect(proof?.signature).toBe('c2ln');
    });
});
