import { describe, it, expect, vi } from 'vitest';
import { derivePrfKeys, PrfUnavailableError } from './index.js';
import { deriveKeyFromPrf } from './derive.js';

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
    it('prompts once and derives one key per label', async () => {
        const getFn = getFnReturning(new Uint8Array(PRF_OUTPUT));
        const labels = ['jaw.id/backup-encryption/v1', 'jaw.id/privacy-pools/root/v1'] as const;

        const keys = await derivePrfKeys({ rpId: 'keys.jaw.id', credentialId: CREDENTIAL_ID, getFn }, labels);

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
        const keys = await derivePrfKeys(
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
});
