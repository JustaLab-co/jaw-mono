import { describe, it, expect, afterEach, vi } from 'vitest';

import { buildHandleJawRpcUrl, fetchRPCRequest, isBackendRefusal } from './provider.js';
import { setDappOrigin } from '../dappOrigin.js';

describe('buildHandleJawRpcUrl', () => {
    it('appends the api-key when the caller has one', () => {
        expect(buildHandleJawRpcUrl('https://rpc.example', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6')).toBe(
            'https://rpc.example/handle?api-key=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'
        );
    });

    // Sending `api-key=` empty would reach the proxy as a malformed key and be
    // rejected before anything else is considered, so the parameter goes away.
    it('omits the parameter entirely when there is no key', () => {
        expect(buildHandleJawRpcUrl('https://rpc.example')).toBe('https://rpc.example/handle');
        expect(buildHandleJawRpcUrl('https://rpc.example', '')).toBe('https://rpc.example/handle');
    });
});

describe('fetchRPCRequest', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function stubResponse(status: number, body: string) {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: status >= 200 && status < 300,
                status,
                json: async () => JSON.parse(body),
                text: async () => body,
            })
        );
    }

    it('returns the JSON-RPC result on success', async () => {
        stubResponse(200, JSON.stringify({ result: { atomic: { status: 'supported' } } }));

        await expect(fetchRPCRequest({ method: 'wallet_getCapabilities' }, 'https://rpc.example')).resolves.toEqual({
            atomic: { status: 'supported' },
        });
    });

    it('throws the JSON-RPC error when the proxy answers with one', async () => {
        stubResponse(200, JSON.stringify({ error: { code: -32000, message: 'nope' } }));

        await expect(fetchRPCRequest({ method: 'wallet_getAssets' }, 'https://rpc.example')).rejects.toMatchObject({
            message: 'nope',
        });
    });

    // The refusal a guard sends is not a JSON-RPC envelope. Destructuring it used
    // to yield `{ result: undefined, error: undefined }` and resolve to undefined,
    // which wallet_getCapabilities then memoized for a minute.
    it('throws on a rejection instead of resolving to undefined', async () => {
        stubResponse(401, JSON.stringify({ statusCode: 401, message: 'Api key not found' }));

        await expect(fetchRPCRequest({ method: 'wallet_getCapabilities' }, 'https://rpc.example')).rejects.toThrow(
            /401/
        );
    });

    it('reports the status for a non-auth failure too', async () => {
        stubResponse(502, 'Bad Gateway');

        await expect(fetchRPCRequest({ method: 'wallet_getAssets' }, 'https://rpc.example')).rejects.toThrow(/502/);
    });

    // An error status can still carry a JSON-RPC envelope, and that envelope is the
    // only place a revert reason reaches the dApp: a 200-char slice of the body
    // would drop both the code and the ABI-encoded data.
    it('throws the JSON-RPC error even when the status says failure', async () => {
        stubResponse(400, JSON.stringify({ error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }));

        await expect(fetchRPCRequest({ method: 'eth_call' }, 'https://rpc.example')).rejects.toMatchObject({
            code: 3,
            message: 'execution reverted',
            data: '0x08c379a0',
        });
    });

    // A 200 carrying an HTML error page from something in front of the proxy used to
    // resolve to undefined, which wallet_getCapabilities then memoized for a minute.
    it('fails on a 2xx whose body is not a JSON-RPC response', async () => {
        stubResponse(200, '<html>upstream timeout</html>');

        await expect(fetchRPCRequest({ method: 'wallet_getCapabilities' }, 'https://rpc.example')).rejects.toThrow(
            /not a JSON-RPC response/
        );
    });

    // `{}` and `[]` are objects too, so a guard on the type alone lets them through
    // and hands the caller the same undefined an HTML body used to.
    it.each([
        ['an empty object', '{}'],
        ['an array', '[]'],
    ])('fails on a 2xx whose body is %s', async (_label, body) => {
        stubResponse(200, body);

        await expect(fetchRPCRequest({ method: 'wallet_getCapabilities' }, 'https://rpc.example')).rejects.toThrow(
            /not a JSON-RPC response/
        );
    });

    // A method that answers with null answered: the envelope carries `result`.
    it('returns a null result', async () => {
        stubResponse(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));

        await expect(
            fetchRPCRequest({ method: 'eth_getTransactionReceipt' }, 'https://rpc.example')
        ).resolves.toBeNull();
    });

    it('still fails when the rejection body cannot be read', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 403,
                text: async () => {
                    throw new Error('stream already consumed');
                },
            })
        );

        await expect(fetchRPCRequest({ method: 'wallet_getPermissions' }, 'https://rpc.example')).rejects.toThrow(
            /403/
        );
    });
});

describe('fetchRPCRequest and the calling dApp', () => {
    afterEach(() => {
        setDappOrigin(undefined);
        vi.unstubAllGlobals();
    });

    function captureHeaders() {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ result: '0x1' }),
        });
        vi.stubGlobal('fetch', fetchMock);
        return () => fetchMock.mock.calls[0][1].headers as Record<string, string>;
    }

    // A dApp's own page never sets one: the browser already puts the right
    // Origin on the request, so a value here would be a claim it did not make.
    it('sends no dApp header when none was set', async () => {
        const headers = captureHeaders();

        await fetchRPCRequest({ method: 'eth_chainId' }, 'https://rpc.example');

        expect(headers()).not.toHaveProperty('x-dapp-origin');
    });

    it('sends the dApp it was told it is acting for', async () => {
        const headers = captureHeaders();
        setDappOrigin('https://dapp.example');

        await fetchRPCRequest({ method: 'eth_chainId' }, 'https://rpc.example');

        expect(headers()['x-dapp-origin']).toBe('https://dapp.example');
    });

    it('stops sending it once it is cleared', async () => {
        setDappOrigin('https://dapp.example');
        setDappOrigin(undefined);
        const headers = captureHeaders();

        await fetchRPCRequest({ method: 'eth_chainId' }, 'https://rpc.example');

        expect(headers()).not.toHaveProperty('x-dapp-origin');
    });
});

// The marker the capabilities cache reads. It stays out of the error itself:
// `JAWProvider` serialises what it catches straight to the dApp.
describe('a refusal is marked without being announced', () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubResponse(status: number, body: string) {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: status >= 200 && status < 300,
                status,
                json: async () => JSON.parse(body),
                text: async () => body,
            })
        );
    }

    it.each([401, 403])('marks a %s, whatever the body was', async (status) => {
        stubResponse(status, 'no');

        const error = await fetchRPCRequest({ method: 'wallet_getCapabilities' }, 'https://rpc.example').catch(
            (e) => e
        );

        expect(isBackendRefusal(error)).toBe(true);
        expect(Object.keys(error as object)).not.toContain('refused');
    });

    it('marks a refusal that came wrapped in an envelope', async () => {
        stubResponse(403, JSON.stringify({ error: { code: -32001, message: 'origin not registered' } }));

        const error = await fetchRPCRequest({ method: 'wallet_getCapabilities' }, 'https://rpc.example').catch(
            (e) => e
        );

        expect(error).toMatchObject({ code: -32001 });
        expect(isBackendRefusal(error)).toBe(true);
    });

    it('leaves a server error unmarked, since asking again can answer it', async () => {
        stubResponse(502, 'Bad Gateway');

        const error = await fetchRPCRequest({ method: 'wallet_getAssets' }, 'https://rpc.example').catch((e) => e);

        expect(isBackendRefusal(error)).toBe(false);
    });
});
