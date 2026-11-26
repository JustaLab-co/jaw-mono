/**
 * Where passkey registration and lookup are sent. `serverUrl` is the passkeys
 * endpoint itself, so a custom server receives GET and POST at exactly that URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    lookupPasskeyFromBackend,
    passkeysEndpoint,
    registerPasskeyInBackend,
    updatePasskeyInBackend,
} from './utils.js';

const request = vi.fn();
const backendInstance = vi.fn((_dev?: boolean, _baseUrl?: string) => ({ request }));

vi.mock('../api/axiosController.js', async () => {
    const actual = await vi.importActual<typeof import('../api/axiosController.js')>('../api/axiosController.js');
    return {
        ...actual,
        backendInstance: (dev?: boolean, baseUrl?: string) => backendInstance(dev, baseUrl),
    };
});

const PASSKEY = { credentialId: 'cred-1', publicKey: '0xabc', displayName: 'alice' } as const;

/** The base url and path the last request went to. */
function lastTarget() {
    const [, baseUrl] = backendInstance.mock.calls.at(-1) ?? [];
    const { url } = request.mock.calls.at(-1)?.[0] ?? {};
    return { baseUrl, url };
}

describe('passkeysEndpoint', () => {
    it.each([
        ['https://passkeys.example.com/passkeys', 'https://passkeys.example.com', '/passkeys'],
        ['https://passkeys.example.com/api/v1/passkeys/', 'https://passkeys.example.com', '/api/v1/passkeys'],
        ['https://passkeys.example.com', 'https://passkeys.example.com', '/'],
        ['http://localhost:3000/passkeys', 'http://localhost:3000', '/passkeys'],
        ['https://api.justaname.id/wallet/v2/passkeys', 'https://api.justaname.id', '/wallet/v2/passkeys'],
    ])('splits %s into its origin and path', (passkeysUrl, baseUrl, path) => {
        expect(passkeysEndpoint(passkeysUrl)).toEqual({ baseUrl, path });
    });

    it('refuses a url that is not absolute', () => {
        expect(() => passkeysEndpoint('/passkeys')).toThrow();
    });
});

describe('a custom passkey server', () => {
    afterEach(() => {
        request.mockReset();
        backendInstance.mockClear();
    });

    it('receives the registration as a POST at its configured url', async () => {
        request.mockResolvedValue({ data: { statusCode: 201, result: { data: {}, error: null } } });

        await registerPasskeyInBackend(PASSKEY, 'k1', false, 'https://passkeys.example.com/passkeys');

        expect(lastTarget()).toEqual({ baseUrl: 'https://passkeys.example.com', url: '/passkeys' });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', data: PASSKEY }));
    });

    it('receives the lookup as a GET at its configured url', async () => {
        request.mockResolvedValue({
            data: { statusCode: 200, result: { data: { passkeys: [PASSKEY] }, error: null } },
        });

        await expect(
            lookupPasskeyFromBackend('cred-1', 'k1', false, 'https://passkeys.example.com/passkeys')
        ).resolves.toEqual(PASSKEY);

        expect(lastTarget()).toEqual({ baseUrl: 'https://passkeys.example.com', url: '/passkeys' });
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'GET', params: { credentialIds: ['cred-1'] } })
        );
    });
});

describe('without a custom server', () => {
    afterEach(() => {
        request.mockReset();
        backendInstance.mockClear();
    });

    it('registers at the JAW passkeys route', async () => {
        request.mockResolvedValue({ data: { statusCode: 201, result: { data: {}, error: null } } });

        await registerPasskeyInBackend(PASSKEY, 'k1');

        expect(lastTarget()).toEqual({ baseUrl: undefined, url: '/wallet/v2/passkeys' });
    });

    it('calls the same url as the default serverUrl does', async () => {
        request.mockResolvedValue({ data: { statusCode: 201, result: { data: {}, error: null } } });

        await registerPasskeyInBackend(PASSKEY, 'k1', false, 'https://api.justaname.id/wallet/v2/passkeys');

        expect(lastTarget()).toEqual({ baseUrl: 'https://api.justaname.id', url: '/wallet/v2/passkeys' });
    });
});

describe('updating a registered passkey', () => {
    const UPDATE = { prfSupported: true, backupState: true };

    afterEach(() => {
        request.mockReset();
        backendInstance.mockClear();
    });

    it('PATCHes the JAW passkeys route at the credential, with only the changed fields', async () => {
        request.mockResolvedValue({ data: { statusCode: 200, result: { data: {}, error: null } } });

        await updatePasskeyInBackend('cred/1', UPDATE, 'k1');

        expect(lastTarget()).toEqual({ baseUrl: undefined, url: '/wallet/v2/passkeys/cred%2F1' });
        expect(request).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'PATCH', data: UPDATE, headers: { 'x-api-key': 'k1' } })
        );
    });

    it.each([
        ['https://passkeys.example.com/passkeys', 'https://passkeys.example.com', '/passkeys/cred-1'],
        ['https://passkeys.example.com/api/v1/passkeys/', 'https://passkeys.example.com', '/api/v1/passkeys/cred-1'],
        ['https://passkeys.example.com', 'https://passkeys.example.com', '/cred-1'],
    ])('PATCHes a custom server %s below its configured url', async (serverUrl, baseUrl, url) => {
        request.mockResolvedValue({ data: { statusCode: 200, result: { data: {}, error: null } } });

        await updatePasskeyInBackend('cred-1', UPDATE, 'k1', false, serverUrl);

        expect(lastTarget()).toEqual({ baseUrl, url });
    });

    it('wraps a failure in PasskeyRegistrationError', async () => {
        request.mockRejectedValue(new Error('404'));

        await expect(updatePasskeyInBackend('cred-1', UPDATE)).rejects.toThrow('Failed to update passkey');
    });
});
