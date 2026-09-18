import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleGetCapabilitiesRequest, clearCapabilitiesCache } from './capabilities.js';

const CAPS = { '0x2105': { feeToken: { supported: true } } };

function stubFetch(impl?: () => Promise<unknown>) {
    const fn = vi.fn(async () => {
        if (impl) await impl();
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: CAPS }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

const request = { method: 'wallet_getCapabilities', params: [] };

beforeEach(() => {
    clearCapabilitiesCache();
    vi.useRealTimers();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // `unstubAllGlobals` does not touch spies and this config sets no `restoreMocks`,
    // so without this the Date.now spy below leaks into whatever test is added next.
    vi.restoreAllMocks();
});

describe('handleGetCapabilitiesRequest caching', () => {
    it('fetches once and serves the cached response afterwards', async () => {
        const fetchSpy = stubFetch();

        const first = await handleGetCapabilitiesRequest(request, 'key', true);
        const second = await handleGetCapabilitiesRequest(request, 'key', true);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(first).toEqual(CAPS);
        expect(second).toEqual(CAPS);
    });

    // Every dialog asks for this on mount, and several can mount at once.
    it('shares a single request between concurrent callers', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const fetchSpy = stubFetch(() => gate);

        const all = Promise.all([
            handleGetCapabilitiesRequest(request, 'key', true),
            handleGetCapabilitiesRequest(request, 'key', true),
            handleGetCapabilitiesRequest(request, 'key', true),
        ]);
        release();
        const results = await all;

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(results).toEqual([CAPS, CAPS, CAPS]);
    });

    // Keys reads the key out of the rpc url and gets '' for a dApp that has none,
    // while the SDK passes undefined. Both are the same caller.
    it('treats an empty key and no key as one caller', async () => {
        const fetchSpy = stubFetch();

        await handleGetCapabilitiesRequest(request, undefined, true);
        await handleGetCapabilitiesRequest(request, '', true);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('keys the cache separately per api key', async () => {
        const fetchSpy = stubFetch();

        await handleGetCapabilitiesRequest(request, 'key-a', true);
        await handleGetCapabilitiesRequest(request, 'key-b', true);

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    // showTestnets=false injects a mainnet chain filter, so the effective request differs.
    it('keys the cache separately per effective chain filter', async () => {
        const fetchSpy = stubFetch();

        await handleGetCapabilitiesRequest(request, 'key', true);
        await handleGetCapabilitiesRequest(request, 'key', false);

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    // An origin the backend will not serve answers the same way every time, and the
    // icon hook asks per chain: without this a chain picker re-fires one refused
    // request per chain on every mount.
    it('holds a refusal for its window instead of asking again', async () => {
        const fetchSpy = vi.fn(async () => new Response('no', { status: 403 }));
        vi.stubGlobal('fetch', fetchSpy);

        await expect(handleGetCapabilitiesRequest(request, 'key', true)).rejects.toMatchObject({ code: 4100 });
        await expect(handleGetCapabilitiesRequest(request, 'key', true)).rejects.toMatchObject({ code: 4100 });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // The other half of the rule: a blip is not an answer, and nothing here retries
    // on its own, so holding one would leave a dialog without its fee row for the
    // whole window over a failure that was already gone.
    it('lets the next caller retry after a transient failure', async () => {
        let calls = 0;
        const fetchSpy = vi.fn(async () => {
            calls++;
            if (calls === 1) throw new Error('network down');
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: CAPS }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchSpy);

        await expect(handleGetCapabilitiesRequest(request, 'key', true)).rejects.toThrow('network down');
        await expect(handleGetCapabilitiesRequest(request, 'key', true)).resolves.toEqual(CAPS);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('retries once the refusal goes stale', async () => {
        let calls = 0;
        const fetchSpy = vi.fn(async () => {
            calls++;
            if (calls === 1) return new Response('no', { status: 403 });
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: CAPS }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchSpy);

        await expect(handleGetCapabilitiesRequest(request, 'key', true)).rejects.toMatchObject({ code: 4100 });
        // The refusal window is 30s; jump past it.
        const realNow = Date.now;
        vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000);

        await expect(handleGetCapabilitiesRequest(request, 'key', true)).resolves.toEqual(CAPS);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('refetches once the entry goes stale', async () => {
        const fetchSpy = stubFetch();

        await handleGetCapabilitiesRequest(request, 'key', true);
        // TTL is 60s; jump past it.
        const realNow = Date.now;
        vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
        await handleGetCapabilitiesRequest(request, 'key', true);

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    // JAWProvider forwards this result straight to the dApp, and the internal UI call
    // sites share the `params: []` entry — a live cache entry would let any one of them
    // corrupt the rest.
    it('hands every caller its own copy, so a mutation cannot leak into the cache', async () => {
        stubFetch();

        const first = (await handleGetCapabilitiesRequest(request, 'key', true)) as Record<string, { evil?: boolean }>;
        first['0x2105'].evil = true;

        const second = await handleGetCapabilitiesRequest(request, 'key', true);

        expect(second).toEqual(CAPS);
    });

    it('does not share one object between concurrent callers', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        stubFetch(() => gate);

        const all = Promise.all([
            handleGetCapabilitiesRequest(request, 'key', true),
            handleGetCapabilitiesRequest(request, 'key', true),
        ]);
        release();
        const [a, b] = await all;

        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});
