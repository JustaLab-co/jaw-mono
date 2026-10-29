import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { restCall } from './rest.js';
import { setDappOrigin } from '../dappOrigin.js';

interface Received {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
}

let server: Server;
let serverUrl: string;
let received: Received[] = [];
let reply: { status: number; body: string } = { status: 200, body: JSON.stringify({ result: { data: {} } }) };

function replyWith(status: number, body: unknown) {
    reply = { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function last(): Received {
    return received[received.length - 1];
}

beforeAll(async () => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
            res.writeHead(reply.status, { 'content-type': 'application/json' });
            res.end(reply.body);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
    received = [];
    replyWith(200, { result: { data: {} } });
    setDappOrigin(undefined);
    vi.restoreAllMocks();
});

describe('restCall on the wire', () => {
    it('repeats an array param in the query of a GET and sends no body', async () => {
        await restCall('LOOKUP_PASSKEYS', 'GET', { credentialIds: ['a', 'b'] }, undefined, undefined, false, serverUrl);

        expect(last()).toMatchObject({
            method: 'GET',
            url: '/wallet/v2/passkeys?credentialIds=a&credentialIds=b',
            body: '',
        });
    });

    it('sends a POST request as a JSON body with no query', async () => {
        const request = { credentialId: 'c1', publicKey: '0x01', displayName: 'me' };

        await restCall('REGISTER_PASSKEY', 'POST', request, {}, undefined, false, serverUrl);

        expect(last()).toMatchObject({ method: 'POST', url: '/wallet/v2/passkeys' });
        expect(last().headers['content-type']).toMatch(/^application\/json/);
        expect(JSON.parse(last().body)).toEqual(request);
    });

    it('substitutes an encoded path param and sends no body on DELETE', async () => {
        await restCall('DELETE_PERMISSION', 'DELETE', {}, {}, { hash: 'a/b' }, false, serverUrl);

        expect(last()).toMatchObject({ method: 'DELETE', url: '/permissions/a%2Fb', body: '' });
    });

    it('puts the query params of a PATCH in the query and the request in the body', async () => {
        const request = { status: 200, transactionHash: '0xbb' as const };

        await restCall('UPDATE_CALL_STATUS', 'PATCH', request, undefined, { id: 'x/y' }, false, serverUrl, {
            'api-key': 'k1',
        });

        expect(last()).toMatchObject({ method: 'PATCH', url: '/rpc/calls-history/x%2Fy?api-key=k1' });
        expect(JSON.parse(last().body)).toEqual(request);
    });

    it('sends a PATCH with no query params without a query', async () => {
        const request = { status: 200, transactionHash: '0xbb' as const };

        await restCall('UPDATE_CALL_STATUS', 'PATCH', request, undefined, { id: 'x' }, false, serverUrl);

        expect(last().url).toBe('/rpc/calls-history/x');
        expect(JSON.parse(last().body)).toEqual(request);
    });

    it('calls the path it is given instead of the route', async () => {
        await restCall(
            'GET_PERMISSION',
            'GET',
            {},
            {},
            { hash: '0xabc' },
            false,
            serverUrl,
            undefined,
            '/custom/:hash'
        );

        expect(last().url).toBe('/custom/0xabc');
    });

    it('sends the headers it is given', async () => {
        await restCall('GET_PERMISSION', 'GET', {}, { 'x-api-key': 'k1' }, { hash: '0xabc' }, false, serverUrl);

        expect(last().headers['x-api-key']).toBe('k1');
    });

    it('returns the data of a successful response', async () => {
        replyWith(200, { result: { data: { hello: 'world' }, error: null } });

        const data = await restCall(
            'LOOKUP_PASSKEYS',
            'GET',
            { credentialIds: ['a'] },
            undefined,
            undefined,
            false,
            serverUrl
        );

        expect(data).toEqual({ hello: 'world' });
    });
});

describe('restCall errors', () => {
    const lookup = () =>
        restCall('LOOKUP_PASSKEYS', 'GET', { credentialIds: ['a'] }, undefined, undefined, false, serverUrl);

    it('turns a 4xx with an error into an Error carrying the message and status', async () => {
        replyWith(404, { statusCode: 404, result: { data: null, error: 'boom' } });

        const err = await lookup().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(AxiosError);
        expect(err).toMatchObject({ message: 'boom', status: 404 });
    });

    it('rejects a 200 with no data with the error it names', async () => {
        replyWith(200, { result: { data: null, error: 'nope' } });

        await expect(lookup()).rejects.toThrow(new Error('nope'));
    });

    it('rejects a 200 with no data and no error with a generic message', async () => {
        replyWith(200, { result: { data: null, error: null } });

        await expect(lookup()).rejects.toThrow(new Error('Something went wrong'));
    });

    it('rethrows the AxiosError of a 5xx without a result', async () => {
        replyWith(502, 'bad gateway');

        const err = await lookup().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AxiosError);
        expect((err as AxiosError).response?.status).toBe(502);
    });

    it('rethrows the AxiosError of a 4xx whose result names no error', async () => {
        replyWith(400, { result: { data: null, error: null } });

        const err = await lookup().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AxiosError);
        expect((err as AxiosError).response?.status).toBe(400);
    });
});

// Our hosts cannot be reached from a test, so these record the request axios
// would send instead of sending it.
describe('restCall host selection', () => {
    let sent: InternalAxiosRequestConfig[] = [];
    const defaultAdapter = axios.defaults.adapter;

    const recorder: AxiosAdapter = async (config) => {
        sent.push(config);
        return { data: { result: { data: {} } }, status: 200, statusText: 'OK', headers: {}, config };
    };

    beforeAll(() => {
        axios.defaults.adapter = recorder;
    });

    afterAll(() => {
        axios.defaults.adapter = defaultAdapter;
    });

    afterEach(() => {
        sent = [];
    });

    function sentTo() {
        return axios.getUri(sent[0]);
    }

    function dappHeader() {
        return sent[0].headers.get('x-dapp-origin');
    }

    const lookup = (dev?: boolean, url?: string) =>
        restCall('LOOKUP_PASSKEYS', 'GET', { credentialIds: ['a'] }, undefined, undefined, dev, url);

    it('calls the wallet API by default and names the dApp there', async () => {
        setDappOrigin('https://dapp.example');

        await lookup();

        expect(sentTo()).toBe('https://api.justaname.id/wallet/v2/passkeys?credentialIds=a');
        expect(dappHeader()).toBe('https://dapp.example');
    });

    it('calls staging in dev mode', async () => {
        await lookup(true);

        expect(sentTo()).toBe('https://api-staging.justaname.id/wallet/v2/passkeys?credentialIds=a');
    });

    it('calls the server url it is given over staging', async () => {
        await lookup(true, 'https://passkeys.dapp.example');

        expect(sentTo()).toBe('https://passkeys.dapp.example/wallet/v2/passkeys?credentialIds=a');
    });

    it('names the dApp to staging given as a server url', async () => {
        setDappOrigin('https://dapp.example');

        await lookup(false, 'https://api-staging.justaname.id/');

        expect(dappHeader()).toBe('https://dapp.example');
    });

    it('sends no dApp header to a server url that does not parse', async () => {
        setDappOrigin('https://dapp.example');

        await lookup(false, 'not a url');

        expect(dappHeader()).toBeUndefined();
    });
});
