import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountsEndpoint, fetchAccountRecordFromBackend } from './utils.js';
import type { AccountRecord } from '../account/accountRecord.js';

const request = vi.fn();
const backendInstance = vi.fn((_dev?: boolean, _baseUrl?: string) => ({ request }));

vi.mock('../api/axiosController.js', async () => {
    const actual = await vi.importActual<typeof import('../api/axiosController.js')>('../api/axiosController.js');
    return {
        ...actual,
        backendInstance: (dev?: boolean, baseUrl?: string) => backendInstance(dev, baseUrl),
    };
});

const RECORD: AccountRecord = {
    address: '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62',
    version: 1,
    factory: '0x5803c076563C85799989d42Fc00292A8aE52fa9E',
    owners: ['0x01', '0x02'],
    nonce: '0',
};

describe('fetchAccountRecordFromBackend', () => {
    afterEach(() => request.mockReset());

    it('asks GET /wallet/v2/accounts for the credential, with the api key', async () => {
        request.mockResolvedValue({ data: { statusCode: 200, result: { data: RECORD, error: null } } });

        const record = await fetchAccountRecordFromBackend('cred-1', 'k1');

        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: '/wallet/v2/accounts',
                method: 'GET',
                params: { credentialId: 'cred-1' },
                headers: { 'x-api-key': 'k1' },
            })
        );
        expect(record).toEqual(RECORD);
    });

    it('rejects when the backend fails', async () => {
        request.mockRejectedValue(new Error('503'));

        await expect(fetchAccountRecordFromBackend('cred-1')).rejects.toThrow();
    });
});

describe('accountsEndpoint', () => {
    it.each([
        ['https://passkeys.example.com/passkeys', 'https://passkeys.example.com', '/accounts'],
        ['https://passkeys.example.com/api/v1/passkeys/', 'https://passkeys.example.com', '/api/v1/accounts'],
        ['https://api.justaname.id/wallet/v2/passkeys', 'https://api.justaname.id', '/wallet/v2/accounts'],
        ['https://passkeys.example.com', 'https://passkeys.example.com', '/accounts'],
    ])('pairs %s with %s%s', (passkeysUrl, baseUrl, path) => {
        expect(accountsEndpoint(passkeysUrl)).toEqual({ baseUrl, path });
    });
});

describe('fetchAccountRecordFromBackend with a custom passkey server', () => {
    afterEach(() => {
        request.mockReset();
        backendInstance.mockClear();
    });

    it('asks the accounts endpoint next to the configured passkeys url', async () => {
        request.mockResolvedValue({ data: { statusCode: 200, result: { data: RECORD, error: null } } });

        await fetchAccountRecordFromBackend('cred-1', 'k1', false, 'https://passkeys.example.com/passkeys');

        expect(backendInstance).toHaveBeenCalledWith(false, 'https://passkeys.example.com');
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({ url: '/accounts', method: 'GET', params: { credentialId: 'cred-1' } })
        );
    });
});
