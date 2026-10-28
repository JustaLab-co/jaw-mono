import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { payAndFetch, type PayAndFetchOptions } from './http.js';
import { toPayAndFetchResult } from './outcome.js';
import type { X402PaymentPayload, X402PaymentRequirement } from './types.js';
import type { Payer } from './payer.js';

// The exact bytes `jaw x402 pay -o json` and the `jaw_pay_and_fetch` meta block
// print for every branch, captured from 0.4.0. Agents parse that JSON, so the
// shape, the key order and the refusal texts are a contract.

const URL_UNDER_TEST = 'https://api.example.com/paid/resource';
const REQUIREMENT: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  maxTimeoutSeconds: 60,
};
const payer: Payer = {
  address: '0x0000000000000000000000000000000000000001',
  pay: async (requirement): Promise<X402PaymentPayload> => ({
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
        nonce: ('0x' + '00'.repeat(32)) as `0x${string}`,
      },
    },
  }),
};
const failingPayer: Payer = {
  address: payer.address,
  pay: async () => {
    throw new Error('eip712Domain read reverted');
  },
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const res = (status: number, headers: Record<string, string> = {}, body = '{}') =>
  ({
    status,
    url: '',
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => body,
  }) as unknown as Response;
const challenge = (requirement = REQUIREMENT) =>
  res(402, { 'PAYMENT-REQUIRED': b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts: [requirement] }) });
const TX = '0xdeadbeef0000000000000000000000000000000000000000000000000000cafe';
const funded = async () => ({ ok: true, amount: '5000', batchId: '0xtopup', approvalBatchId: '0xapprove' });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const printed = async (url: string, opts: PayAndFetchOptions = {}, who: Payer = payer) =>
  JSON.stringify(toPayAndFetchResult(await payAndFetch(url, who, opts)));

describe('payAndFetch output, byte for byte', () => {
  it('a free resource', async () => {
    fetchMock.mockResolvedValueOnce(res(200, {}, '{"data":"free"}'));
    expect(await printed(URL_UNDER_TEST)).toMatchInlineSnapshot(
      `"{"status":200,"body":{"data":"free"},"paid":false,"payer":"0x0000000000000000000000000000000000000001"}"`
    );
  });

  it('a dry run', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    expect(await printed(URL_UNDER_TEST, { dryRun: true })).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"paid":false,"payer":"0x0000000000000000000000000000000000000001","wouldPay":{"scheme":"exact","amount":"1000","authorized":"1000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","network":"eip155:8453","payTo":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"}}"`
    );
  });

  it('a cleartext url', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    expect(await printed('http://api.example.com/paid')).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"payer":"0x0000000000000000000000000000000000000001","refusedReason":"refusing to sign a payment over a non-HTTPS URL (use https, or localhost for testing)","paid":false}"`
    );
  });

  it('a missing challenge', async () => {
    fetchMock.mockResolvedValueOnce(res(402));
    expect(await printed(URL_UNDER_TEST)).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"payer":"0x0000000000000000000000000000000000000001","refusedReason":"missing or malformed PAYMENT-REQUIRED challenge","paid":false}"`
    );
  });

  it('a policy refusal', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    expect(await printed(URL_UNDER_TEST, { maxAmount: '10' })).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"payer":"0x0000000000000000000000000000000000000001","refusedReason":"amount 1000 exceeds maxAmount 10","paid":false}"`
    );
  });

  it('a funding refusal that already moved funds', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    const ensureFunds = async () => ({
      ok: false,
      reason: 'confirmation timed out',
      amount: '5000',
      batchId: '0xtopup',
      approvalBatchId: '0xapprove',
    });
    expect(await printed(URL_UNDER_TEST, { ensureFunds })).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"payer":"0x0000000000000000000000000000000000000001","refusedReason":"confirmation timed out","topUp":{"amount":"5000","batchId":"0xtopup"},"permit2Approval":{"batchId":"0xapprove"},"paid":false}"`
    );
  });

  it('a funding hook that throws', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    const ensureFunds = async () => {
      throw new Error('rpc down');
    };
    expect(await printed(URL_UNDER_TEST, { ensureFunds })).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"payer":"0x0000000000000000000000000000000000000001","refusedReason":"payer funding failed: rpc down","paid":false}"`
    );
  });

  it('a signing failure after a top-up', async () => {
    fetchMock.mockResolvedValueOnce(challenge());
    expect(await printed(URL_UNDER_TEST, { ensureFunds: funded }, failingPayer)).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"payer":"0x0000000000000000000000000000000000000001","refusedReason":"payment signing failed: eip712Domain read reverted","topUp":{"amount":"5000","batchId":"0xtopup"},"permit2Approval":{"batchId":"0xapprove"},"paid":false}"`
    );
  });

  it('a signed payment whose response never arrived', async () => {
    fetchMock.mockResolvedValueOnce(challenge()).mockRejectedValueOnce(new Error('socket hang up'));
    expect(await printed(URL_UNDER_TEST, { ensureFunds: funded })).toMatchInlineSnapshot(
      `"{"status":402,"body":"","payer":"0x0000000000000000000000000000000000000001","refusedReason":"payment sent but the response never arrived: socket hang up","attemptedPayment":{"scheme":"exact","amount":"1000","authorized":"1000","deadline":"9999999999","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","network":"eip155:8453","payTo":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","nonce":"0x0000000000000000000000000000000000000000000000000000000000000000"},"topUp":{"amount":"5000","batchId":"0xtopup"},"permit2Approval":{"batchId":"0xapprove"},"paid":false}"`
    );
  });

  it('a redirect on the paid request', async () => {
    fetchMock.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(res(302, { location: 'https://evil.example' }));
    expect(await printed(URL_UNDER_TEST, { ensureFunds: funded })).toMatchInlineSnapshot(
      `"{"status":302,"body":{},"paid":false,"payer":"0x0000000000000000000000000000000000000001","attemptedPayment":{"scheme":"exact","amount":"1000","authorized":"1000","deadline":"9999999999","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","network":"eip155:8453","payTo":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","nonce":"0x0000000000000000000000000000000000000000000000000000000000000000"},"topUp":{"amount":"5000","batchId":"0xtopup"},"permit2Approval":{"batchId":"0xapprove"},"refusedReason":"settlement endpoint attempted a redirect (302); not following it with the signed proof"}"`
    );
  });

  it('a settlement the server rejected', async () => {
    const reChallenge = b64({
      x402Version: 2,
      error: 'invalid_exact_evm_insufficient_balance',
      resource: { url: URL_UNDER_TEST },
      accepts: [REQUIREMENT],
    });
    fetchMock.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(res(402, { 'PAYMENT-REQUIRED': reChallenge }));
    expect(await printed(URL_UNDER_TEST)).toMatchInlineSnapshot(
      `"{"status":402,"body":{},"paid":false,"payer":"0x0000000000000000000000000000000000000001","attemptedPayment":{"scheme":"exact","amount":"1000","authorized":"1000","deadline":"9999999999","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","network":"eip155:8453","payTo":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","nonce":"0x0000000000000000000000000000000000000000000000000000000000000000"},"refusedReason":"invalid_exact_evm_insufficient_balance"}"`
    );
  });

  it('a paid resource', async () => {
    fetchMock
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(
        res(200, { 'PAYMENT-RESPONSE': b64({ success: true, transaction: TX }) }, '{"data":"ok"}')
      );
    expect(await printed(URL_UNDER_TEST, { ensureFunds: funded })).toMatchInlineSnapshot(
      `"{"status":200,"body":{"data":"ok"},"paid":true,"topUp":{"amount":"5000","batchId":"0xtopup"},"permit2Approval":{"batchId":"0xapprove"},"payer":"0x0000000000000000000000000000000000000001","payment":{"scheme":"exact","amount":"1000","authorized":"1000","deadline":"9999999999","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","network":"eip155:8453","payTo":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","nonce":"0x0000000000000000000000000000000000000000000000000000000000000000","txHash":"0xdeadbeef0000000000000000000000000000000000000000000000000000cafe"}}"`
    );
  });
});
