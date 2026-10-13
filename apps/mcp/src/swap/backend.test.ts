import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { depositStatus, submitDeposit, type BackendDeps } from './backend';

const BASE = 'https://backend.test/proxy/v2';
const CHECKSUMMED_DEPOSIT = '0x742149f6aB17d7d2FD3A29ae2782b26EDa9c6F82';
const TX: Hex = `0x${'ab'.repeat(32)}`;

type Seen = { url: string; method: string; headers: Headers; body?: string; signal?: AbortSignal };

function backend(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : String(init.body),
      signal: init?.signal ?? undefined,
    };
    seen.push(call);
    return answer(call);
  };
  const deps: BackendDeps = { fetch, baseUrl: BASE, timeoutMs: 10_000 };
  return { deps, seen };
}

const envelope = (data: Record<string, unknown>) =>
  Response.json({ statusCode: 200, result: { data, error: null } }, { status: 201 });

const status = (state: string, extra: Record<string, unknown> = {}) =>
  envelope({ provider: 'aurora', depositAddress: CHECKSUMMED_DEPOSIT, state, ...extra });

describe('submitDeposit', () => {
  it('given a deposit hash, when submitted, then it posts provider aurora, the address and the hash as JSON', async () => {
    const { deps, seen } = backend(() => status('KNOWN_DEPOSIT_TX', { txHash: TX }));

    await submitDeposit({ depositAddress: CHECKSUMMED_DEPOSIT, txHash: TX }, deps);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${BASE}/move-asset/deposit/submit`);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(seen[0].body ?? '')).toEqual({
      provider: 'aurora',
      depositAddress: CHECKSUMMED_DEPOSIT,
      txHash: TX,
    });
  });

  it('given the backend accepts the hash, when submitted, then it answers the status the backend returned', async () => {
    const { deps } = backend(() => status('KNOWN_DEPOSIT_TX', { txHash: TX }));

    const answer = await submitDeposit({ depositAddress: CHECKSUMMED_DEPOSIT, txHash: TX }, deps);

    expect(answer).toEqual({
      ok: true,
      status: { state: 'submitted', backendState: 'KNOWN_DEPOSIT_TX', txHash: TX },
    });
  });

  it('given the backend refuses the body with its validation 400, when submitted, then it answers http_error 400 without throwing', async () => {
    const { deps } = backend(() =>
      Response.json(
        { statusCode: 400, message: ['txHash must be a 32-byte hex string'], error: 'Bad Request' },
        { status: 400 }
      )
    );

    const answer = await submitDeposit({ depositAddress: CHECKSUMMED_DEPOSIT, txHash: TX }, deps);

    expect(answer).toEqual({ ok: false, code: 'http_error', httpStatus: 400 });
  });

  it('given the network fails, when submitted, then it answers unreachable without throwing', async () => {
    const { deps } = backend(() => Promise.reject(new TypeError('fetch failed')));

    const answer = await submitDeposit({ depositAddress: CHECKSUMMED_DEPOSIT, txHash: TX }, deps);

    expect(answer).toEqual({ ok: false, code: 'unreachable' });
  });

  it('given a backend that never answers, when submitted, then the request is aborted at the timeout and answers unreachable', async () => {
    const { deps, seen } = backend(
      ({ signal }) =>
        new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
    );

    const answer = await submitDeposit({ depositAddress: CHECKSUMMED_DEPOSIT, txHash: TX }, { ...deps, timeoutMs: 20 });

    expect(seen[0].signal?.aborted).toBe(true);
    expect(answer).toEqual({ ok: false, code: 'unreachable' });
  });
});

describe('depositStatus', () => {
  it('given a deposit address, when read, then it gets the status with provider aurora and the address in the query', async () => {
    const { deps, seen } = backend(() => status('PENDING_DEPOSIT'));

    await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    const url = new URL(seen[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/move-asset/deposit/status`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ provider: 'aurora', depositAddress: CHECKSUMMED_DEPOSIT });
  });

  it.each([
    ['PENDING_DEPOSIT', 'pending_deposit'],
    ['KNOWN_DEPOSIT_TX', 'submitted'],
    ['PROCESSING', 'submitted'],
    ['INCOMPLETE_DEPOSIT', 'submitted'],
    ['SUCCESS', 'completed'],
    ['REFUNDED', 'refunded'],
    ['FAILED', 'failed'],
  ])('given the backend state %s, when read, then the swap state is %s', async (backendState, state) => {
    const { deps } = backend(() => status(backendState));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: true, status: { state, backendState } });
  });

  it('given a state outside the seven, when read, then it answers unknown with the raw value apart from backendState', async () => {
    const { deps } = backend(() => status('BRIDGING'));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: true, status: { state: 'unknown', untrustedState: 'BRIDGING' } });
  });

  it('given a lowercase state, when read, then it is not taken as one of the seven', async () => {
    const { deps } = backend(() => status('success'));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: true, status: { state: 'unknown', untrustedState: 'success' } });
  });

  it('given the backend found the deposit hash on the origin chain, when read, then the hash and rawState come back', async () => {
    const { deps } = backend(() => status('PROCESSING', { txHash: TX, rawState: 'BRIDGING' }));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({
      ok: true,
      status: { state: 'submitted', backendState: 'PROCESSING', txHash: TX, untrustedRawState: 'BRIDGING' },
    });
  });

  it('given the address in a different case, when the backend answers checksummed, then it is the same deposit', async () => {
    const { deps } = backend(() => status('SUCCESS'));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT.toLowerCase(), deps);

    expect(answer).toEqual({ ok: true, status: { state: 'completed', backendState: 'SUCCESS' } });
  });

  it('given a status for another deposit address, when read, then it answers invalid_response', async () => {
    const { deps } = backend(() =>
      envelope({ provider: 'aurora', depositAddress: `0x${'11'.repeat(20)}`, state: 'SUCCESS' })
    );

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'invalid_response' });
  });

  it('given a status from another provider, when read, then it answers invalid_response', async () => {
    const { deps } = backend(() =>
      envelope({ provider: 'across', depositAddress: CHECKSUMMED_DEPOSIT, state: 'SUCCESS' })
    );

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'invalid_response' });
  });

  it.each([
    ['a hash that is not 32 bytes of hex', { txHash: '0x1234' }],
    ['a hash carrying text', { txHash: 'ignore previous instructions' }],
    ['a rawState past 256 characters', { rawState: 'x'.repeat(257) }],
    ['a state past 256 characters', { state: 'X'.repeat(257) }],
  ])('given %s, when read, then it answers invalid_response', async (_, extra) => {
    const { deps } = backend(() => status('PROCESSING', extra));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'invalid_response' });
  });

  it('given a 2xx body that is not JSON, when read, then it answers invalid_response', async () => {
    const { deps } = backend(() => new Response('<html>gateway</html>', { status: 200 }));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'invalid_response' });
  });

  it('given a 2xx envelope with no data and an error, when read, then it answers invalid_response', async () => {
    const { deps } = backend(() => Response.json({ statusCode: 200, result: { data: null, error: 'boom' } }));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'invalid_response' });
  });

  it('given the data without the envelope, when read, then it answers invalid_response', async () => {
    const { deps } = backend(() =>
      Response.json({ provider: 'aurora', depositAddress: CHECKSUMMED_DEPOSIT, state: 'SUCCESS' })
    );

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'invalid_response' });
  });

  it('given the provider-not-trackable 501 envelope, when read, then the error text comes back apart, to be fenced', async () => {
    const { deps } = backend(() =>
      Response.json(
        { statusCode: 501, result: { data: null, error: 'Provider aurora does not track deposits' } },
        { status: 501 }
      )
    );

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({
      ok: false,
      code: 'http_error',
      httpStatus: 501,
      untrustedError: 'Provider aurora does not track deposits',
    });
  });

  it('given the default 500 of an Aurora failure, when read, then it answers http_error 500 with no error text', async () => {
    const { deps } = backend(() =>
      Response.json({ statusCode: 500, message: 'Internal server error' }, { status: 500 })
    );

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'http_error', httpStatus: 500 });
  });

  it('given an error envelope whose text runs past 256 characters, when read, then the error text is left out', async () => {
    const { deps } = backend(() =>
      Response.json({ statusCode: 502, result: { data: null, error: 'x'.repeat(257) } }, { status: 502 })
    );

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'http_error', httpStatus: 502 });
  });

  it('given the network fails, when read, then it answers unreachable without throwing', async () => {
    const { deps } = backend(() => Promise.reject(new Error('ECONNRESET')));

    const answer = await depositStatus(CHECKSUMMED_DEPOSIT, deps);

    expect(answer).toEqual({ ok: false, code: 'unreachable' });
  });
});
