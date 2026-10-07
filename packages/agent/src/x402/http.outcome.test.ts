import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chooseOneOff,
  payAndFetch,
  FetchRefused,
  probe,
  until,
  type Challenge,
  type SignedAuthorization,
} from './http.js';
import type { X402PaymentPayload, X402PaymentRequirement } from './types.js';
import type { Payer } from './payer.js';
import { ensurePayerFunds } from './topup.js';
import type { ChainClients } from '../ports.js';

// What a host that keeps its own payment rows needs from payAndFetch: a kind and
// a code to branch on, the signed authorization before it leaves, a resend that
// never signs twice, one time budget, and its own fetch.

const URL_UNDER_TEST = 'https://api.example.com/paid/resource';
const REQUIREMENT: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  maxTimeoutSeconds: 60,
};
const pay = vi.fn(
  async (requirement: X402PaymentRequirement): Promise<X402PaymentPayload> => ({
    x402Version: 2,
    accepted: requirement,
    payload: {
      signature: '0xstubsig',
      authorization: {
        from: '0x0000000000000000000000000000000000000001',
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: '0',
        validBefore: '9999999999',
        nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
      },
    },
  })
);
const payer: Payer = { address: '0x0000000000000000000000000000000000000001', pay };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const res = (status: number, headers: Record<string, string> = {}, body = '{}') =>
  ({
    status,
    url: '',
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => body,
  }) as unknown as Response;
const challenge = () =>
  res(402, { 'PAYMENT-REQUIRED': b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts: [REQUIREMENT] }) });
const settled = () =>
  res(200, { 'PAYMENT-RESPONSE': b64({ success: true, transaction: '0x' + 'ab'.repeat(32) }) }, '{"data":"ok"}');
const sentHeaders = (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  pay.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('payAndFetch outcome', () => {
  it('names what happened to money, and why when nothing did', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    const refused = await payAndFetch(URL_UNDER_TEST, payer, { maxAmount: '10' });
    expect(refused).toMatchObject({ kind: 'refused', refusal: { code: 'over_cap' } });

    fetchMock.mockResolvedValueOnce(challenge()).mockRejectedValueOnce(new Error('socket hang up'));
    const failed = await payAndFetch(URL_UNDER_TEST, payer);
    expect(failed).toMatchObject({ kind: 'failed', refusal: { code: 'no_response' } });

    fetchMock.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(settled());
    expect(await payAndFetch(URL_UNDER_TEST, payer)).toMatchObject({ kind: 'paid' });
  });

  it('refuses a refill whose status poll timed out after it was sent as funding_failed, with the trace', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    const executor = {
      request: async (method: string) =>
        method === 'wallet_sendCalls' ? { id: '0xbatch1' } : new Promise(() => undefined),
    };
    const outcome = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: (requirement, address) =>
        ensurePayerFunds(requirement, address, executor, {
          clients: {} as ChainClients,
          balanceReader: async () => 0n,
          timeoutMs: 0,
          pollMs: 0,
          sleep: async () => undefined,
          logger: { warn: () => undefined },
        }),
    });

    expect(outcome).toMatchObject({
      kind: 'refused',
      refusal: { code: 'funding_failed', reason: 'top-up status check failed: status check timed out after 0ms' },
      topUp: { batchId: '0xbatch1' },
    });
    expect(pay).not.toHaveBeenCalled();
  });

  it("keeps the funding hook's own code", async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    const outcome = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({ ok: false, code: 'budget_exhausted', reason: 'grant used up' }),
    });
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'budget_exhausted', reason: 'grant used up' } });
  });
});

describe('payAndFetch with a caller that keeps its own rows', () => {
  it('hands over the signed authorization before the proof leaves, under its own key', async () => {
    const order: string[] = [];
    let stored: SignedAuthorization | undefined;
    fetchMock.mockResolvedValueOnce(challenge()).mockImplementationOnce(async () => {
      order.push('sent');
      return settled();
    });

    const outcome = await payAndFetch(URL_UNDER_TEST, payer, {
      attempt: {
        key: 'row-42',
        onSigned: async (authorization) => {
          order.push('stored');
          stored = authorization;
        },
      },
    });

    expect(order).toEqual(['stored', 'sent']);
    expect(outcome.kind).toBe('paid');
    expect(stored).toMatchObject({ resource: URL_UNDER_TEST, details: { nonce: '0x' + '11'.repeat(32) } });
    expect(sentHeaders(fetchMock.mock.calls[1])['Idempotency-Key']).toBe('row-42');
  });

  it('sends nothing when the authorization could not be stored', async () => {
    fetchMock.mockResolvedValueOnce(challenge());

    const outcome = await payAndFetch(URL_UNDER_TEST, payer, {
      attempt: {
        key: 'row-42',
        onSigned: async () => {
          throw new Error('db down');
        },
      },
    });

    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'store_failed' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resends a stored authorization without probing or signing again', async () => {
    let stored: SignedAuthorization | undefined;
    fetchMock.mockResolvedValueOnce(challenge()).mockRejectedValueOnce(new Error('facilitator timed out'));
    await payAndFetch(URL_UNDER_TEST, payer, {
      attempt: { key: 'row-42', onSigned: async (authorization) => void (stored = authorization) },
    });
    const firstProof = sentHeaders(fetchMock.mock.calls[1])['PAYMENT-SIGNATURE'];
    fetchMock.mockClear();
    pay.mockClear();
    fetchMock.mockResolvedValueOnce(settled());

    const outcome = await payAndFetch(URL_UNDER_TEST, payer, { attempt: { key: 'row-42', resume: stored } });

    expect(outcome.kind).toBe('paid');
    expect(pay).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentHeaders(fetchMock.mock.calls[0])).toMatchObject({
      'PAYMENT-SIGNATURE': firstProof,
      'Idempotency-Key': 'row-42',
    });
  });

  it('will not resend an authorization that has expired', async () => {
    const expired: SignedAuthorization = {
      resource: URL_UNDER_TEST,
      payload: {} as X402PaymentPayload,
      details: { ...REQUIREMENT, authorized: '1000', deadline: '1', nonce: ('0x' + '11'.repeat(32)) as `0x${string}` },
    };

    const outcome = await payAndFetch(URL_UNDER_TEST, payer, { attempt: { key: 'row-42', resume: expired } });

    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'authorization_expired' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a key that cannot travel as a header, before any request', async () => {
    await expect(payAndFetch(URL_UNDER_TEST, payer, { attempt: { key: 'bad key\n' } })).rejects.toThrow(
      /idempotency key/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('payAndFetch transport and time', () => {
  it('goes through the fetch it is given, and a refused destination sends no proof', async () => {
    const guarded = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockRejectedValueOnce(new FetchRefused('resolves to a private address'));

    const outcome = await payAndFetch(URL_UNDER_TEST, payer, { fetch: guarded as unknown as typeof fetch });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { code: 'blocked_url' } });
    expect('attempted' in outcome).toBe(false);
  });

  it('starts no request once the time budget is spent', async () => {
    await expect(payAndFetch(URL_UNDER_TEST, payer, { budget: until(Date.now() - 1) })).rejects.toThrow(/time budget/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the funding hook the same budget', async () => {
    const budget = until(Date.now() + 60_000);
    const ensureFunds = vi.fn(async () => ({ ok: false, reason: 'no' }));
    fetchMock.mockResolvedValueOnce(challenge());

    await payAndFetch(URL_UNDER_TEST, payer, { budget, ensureFunds });

    expect(ensureFunds).toHaveBeenCalledWith(expect.anything(), payer.address, budget);
  });
});

describe('the challenge a refusal carries, for a one-off', () => {
  const withSessionCap = { policy: { maxTotalPerSession: '1500' }, spentThisSession: 1000n };

  it('is on budget_exhausted from the policy, before any option was chosen', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    const outcome = await payAndFetch(URL_UNDER_TEST, payer, withSessionCap);
    expect(outcome).toMatchObject({
      kind: 'refused',
      refusal: { code: 'budget_exhausted' },
      challenge: { resource: URL_UNDER_TEST, accepts: [REQUIREMENT] },
    });
    expect(pay).not.toHaveBeenCalled();
  });

  it('is on budget_exhausted from the funding hook, the same challenge', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    const outcome = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({ ok: false, code: 'budget_exhausted', reason: 'grant used up' }),
    });
    expect(outcome).toMatchObject({ challenge: { resource: URL_UNDER_TEST, accepts: [REQUIREMENT] } });
  });

  it('is absent before the challenge was read', async () => {
    fetchMock.mockResolvedValueOnce(res(402, {}));
    const outcome = await payAndFetch(URL_UNDER_TEST, payer);
    expect(outcome).toMatchObject({ refusal: { code: 'malformed_challenge' } });
    expect('challenge' in outcome).toBe(false);
  });
});

describe('probe', () => {
  it('reads the challenge from the final url, keeping only well-formed options', async () => {
    const header = b64({ x402Version: 2, accepts: [REQUIREMENT, { scheme: 'exact', amount: 'lots' }] });
    fetchMock.mockResolvedValueOnce({ ...res(402, { 'PAYMENT-REQUIRED': header }), url: `${URL_UNDER_TEST}?v=2` });
    expect(await probe(URL_UNDER_TEST, {})).toMatchObject({
      kind: 'challenge',
      challenge: { resource: `${URL_UNDER_TEST}?v=2`, accepts: [REQUIREMENT] },
    });
  });

  it('passes a free answer through and refuses cleartext and a missing header', async () => {
    fetchMock.mockResolvedValueOnce(res(200, {}, '{"free":true}'));
    expect(await probe(URL_UNDER_TEST, {})).toEqual({ kind: 'free', status: 200, body: { free: true } });
    fetchMock.mockResolvedValueOnce(res(402, {}));
    expect(await probe(URL_UNDER_TEST, {})).toMatchObject({
      kind: 'refused',
      refusal: { code: 'malformed_challenge' },
    });
    fetchMock.mockResolvedValueOnce(challenge());
    expect(await probe('http://api.example.com/x', {})).toMatchObject({ refusal: { code: 'insecure_url' } });
  });
});

describe('chooseOneOff', () => {
  const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const option = (over: Partial<X402PaymentRequirement>): X402PaymentRequirement => ({
    ...REQUIREMENT,
    network: 'eip155:84532',
    asset: USDC_BASE_SEPOLIA,
    ...over,
  });
  const offered = (...accepts: X402PaymentRequirement[]): Challenge => ({ resource: URL_UNDER_TEST, accepts });

  it('takes the cheapest exact option on the network, with no cap from any budget', () => {
    const chosen = chooseOneOff(
      offered(option({ amount: '900', scheme: 'upto' }), option({ amount: '5000000000' }), option({ amount: '3000' })),
      { network: 'eip155:84532' }
    );
    expect(chosen).toMatchObject({ scheme: 'exact', amount: '3000' });
  });

  it("still honors the agent's own maxAmount and the network", () => {
    const challenge = offered(option({ amount: '3000' }), option({ amount: '10', network: 'eip155:8453' }));
    expect(chooseOneOff(challenge, { network: 'eip155:84532', maxAmount: '2999' })).toBeUndefined();
    expect(chooseOneOff(challenge, { network: 'eip155:84532', maxAmount: '3000' })).toMatchObject({ amount: '3000' });
  });

  it('offers nothing for an upto-only challenge or a zero recipient', () => {
    expect(chooseOneOff(offered(option({ scheme: 'upto' })), { network: 'eip155:84532' })).toBeUndefined();
    const zero = option({ payTo: `0x${'0'.repeat(40)}` as `0x${string}` });
    expect(chooseOneOff(offered(zero), { network: 'eip155:84532' })).toBeUndefined();
  });
});
