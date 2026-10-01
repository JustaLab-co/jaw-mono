import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { settledAmountOf, payAndFetch } from './http.js';
import { buildUptoPayment } from './scheme-upto-evm.js';
import { X402_UPTO_PROXY_ADDRESS } from './permit2.js';
import type { Payer } from './payer.js';
import type { X402PaymentPayload, X402PaymentRequirement } from './types.js';

const URL_UNDER_TEST = 'https://api.example.com/paid/resource';

const REQUIREMENT: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  maxTimeoutSeconds: 60,
};

// A stub payer — the http loop only encodes and sends what it returns; it does
// not verify the signature, so no real key is needed here.
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

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

interface MockResInit {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Final URL after redirects (Response.url); defaults to the request URL. */
  url?: string;
}
const mockRes = ({ status, headers = {}, body = '', url = '' }: MockResInit): Response =>
  ({
    status,
    url,
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => body,
  }) as unknown as Response;

/**
 * A response whose headers have arrived but whose body never finishes — what a
 * server that trickles bytes looks like. The reader only settles when the
 * request's own signal aborts, the way undici errors a stream on abort.
 */
const stallingRes = ({ status, headers = {} }: Omit<MockResInit, 'body'>, signal: AbortSignal | undefined): Response =>
  ({
    status,
    url: '',
    headers: { get: (k: string) => headers[k] ?? null },
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
        releaseLock: () => undefined,
        cancel: async () => undefined,
      }),
    },
    text: async () => '',
  }) as unknown as Response;

const challengeHeader = b64({
  x402Version: 2,
  resource: { url: URL_UNDER_TEST },
  accepts: [REQUIREMENT],
});
// A settlement tx hash has to be a real 32-byte hash to survive the shape check
// the receipt goes through, so the stub uses one.
const RECEIPT_TX = '0xdeadbeef0000000000000000000000000000000000000000000000000000cafe';
const receiptHeader = b64({ success: true, transaction: RECEIPT_TX });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('payAndFetch', () => {
  it('passes a free (non-402) resource straight through without paying', async () => {
    fetchMock.mockResolvedValueOnce(mockRes({ status: 200, body: JSON.stringify({ free: true }) }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ free: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it('aborts a hung request after the timeout instead of hanging forever', async () => {
    // A server that never responds must not wedge the call (which would, via
    // the payment mutex, wedge every subsequent payment). fetchWithTimeout
    // aborts after its deadline; the mock rejects when the signal fires.
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      );
      const promise = payAndFetch(URL_UNDER_TEST, payer);
      const assertion = expect(promise).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to sign a payment over a cleartext http URL (MITM could rewrite payTo)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );

    const result = await payAndFetch('http://api.example.com/paid/resource', payer);

    expect(result.paid).toBe(false);
    expect(result.status).toBe(402);
    expect(result.refusedReason).toMatch(/non-HTTPS/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never signed, never retried
  });

  it('still passes a free (non-402) http resource straight through', async () => {
    // The HTTPS gate is only for signing — a plain http fetch must still work.
    fetchMock.mockResolvedValueOnce(mockRes({ status: 200, body: JSON.stringify({ free: true }) }));

    const result = await payAndFetch('http://api.example.com/free', payer);

    expect(result.paid).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ free: true });
  });

  it('refuses when an https URL was redirected down to http before the 402 (gate on final URL)', async () => {
    // fetch follows https->http redirects by default; the 402 challenge here
    // arrived over cleartext even though the caller passed an https URL.
    fetchMock.mockResolvedValueOnce(
      mockRes({
        status: 402,
        headers: { 'PAYMENT-REQUIRED': challengeHeader },
        body: '{}',
        url: 'http://attacker.example.com/fake-challenge',
      })
    );

    const result = await payAndFetch('https://trusted.example.com/api', payer);

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toMatch(/non-HTTPS/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never signed
  });

  it('sends the signed proof to the resolved secure resource with redirects disabled', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockRes({
          status: 402,
          headers: { 'PAYMENT-REQUIRED': challengeHeader },
          body: '{}',
          url: 'https://cdn.example.com/paid', // resolved after a same-protocol redirect
        })
      )
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch('https://api.example.com/paid/resource', payer);

    expect(result.paid).toBe(true);
    const retryUrl = fetchMock.mock.calls[1][0] as string;
    const retryInit = fetchMock.mock.calls[1][1] as { redirect?: string };
    expect(retryUrl).toBe('https://cdn.example.com/paid'); // the resolved resource, not the original
    expect(retryInit.redirect).toBe('manual'); // signature never follows a redirect
  });

  it('treats a redirect on the paid retry as a settlement failure (never follows the signed proof)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(mockRes({ status: 302, headers: { location: 'http://attacker.example.com' }, body: '' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.status).toBe(302);
    expect(result.refusedReason).toMatch(/redirect/);
    expect(result.attemptedPayment).toBeTruthy(); // signed, so surfaced for reconciliation
  });

  it('allows signing over http for loopback (local dev/test servers)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch('http://localhost:8080/paid', payer);

    expect(result.paid).toBe(true);
  });

  it('pays a 402 and returns the resource + receipt', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: 'ok' });
    expect(result.payment).toMatchObject({ amount: '1000', payTo: REQUIREMENT.payTo, txHash: RECEIPT_TX });

    // The retry carried the PAYMENT-SIGNATURE proof.
    const retryInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    expect(retryInit.headers['PAYMENT-SIGNATURE']).toBeTruthy();
    expect(retryInit.headers['Idempotency-Key']).toBeTruthy();
  });

  it('drops a settlement tx hash that is not one, so it cannot reach a terminal or the trusted meta block', async () => {
    // `transaction` reaches `x402 pay`'s output and the MCP meta block, so it
    // needs the same shape check the rest of the receipt gets. `\x1b[2K\r`
    // erases the line the CLI just wrote and repaints it with what follows.
    const hostileReceipt = b64({ success: true, transaction: '\x1b[2K\rPaid. 500 USDC ‮ gnihton' });
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': hostileReceipt }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    // The payment still happened and is still recorded (the nonce reconciles
    // it); only the unusable hash is dropped.
    expect(result.paid).toBe(true);
    expect(result.payment?.txHash).toBeUndefined();
    expect(result.payment?.nonce).toBeTruthy();
  });

  it('bounds the body read by the same deadline as the request, without losing a settled payment', async () => {
    // fetch resolves on HEADERS, so clearing the deadline there leaves the body
    // read unbounded: a server that trickles bytes holds the payment mutex open
    // after the money moved, the ledger append never runs, and another process
    // breaks the stale lock and re-spends against a ledger missing this payment.
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
        .mockImplementationOnce((_url: string, init: { signal?: AbortSignal }) =>
          Promise.resolve(stallingRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader } }, init.signal))
        );

      const promise = payAndFetch(URL_UNDER_TEST, payer);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await promise;

      expect(result.body).toEqual({ error: expect.stringMatching(/body timed out/) });
      // The settlement succeeded; the caller must still get the record to write.
      expect(result.paid).toBe(true);
      expect(result.payment?.txHash).toBe(RECEIPT_TX);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the funding hook before paying and surfaces the top-up in the result', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({ ok: true, amount: '750000', batchId: '0xbatch1' }),
    });

    expect(result.paid).toBe(true);
    expect(result.topUp).toEqual({ amount: '750000', batchId: '0xbatch1' });
  });

  /**
   * The Permit2 approval is a userOp charged to the payer's USDC and it can run
   * with no top-up beside it, when the balance already covered the price. Gated
   * on `skipped` it reached neither the result nor the ledger, so a payment the
   * user paid gas for left no trace at all.
   */
  it('surfaces a Permit2 approval that ran even when no principal had to move', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({ ok: true, skipped: true, approvalBatchId: '0xapproval1' }),
    });

    expect(result.paid).toBe(true);
    expect(result.topUp).toBeUndefined();
    expect(result.permit2Approval).toEqual({ batchId: '0xapproval1' });
  });

  it('surfaces a signing failure after a top-up as a structured refusal carrying the top-up trace', async () => {
    // A throw from payer.pay() AFTER ensureFunds already moved funds must not
    // escape bare: the moved funds need to reach the audit ledger via topUp.
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );
    const throwingPayer: Payer = {
      address: payer.address,
      pay: async () => {
        throw new Error('eip712Domain read reverted');
      },
    };

    const result = await payAndFetch(URL_UNDER_TEST, throwingPayer, {
      ensureFunds: async () => ({ ok: true, amount: '500000', batchId: '0xbatch9' }),
    });

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toMatch(/payment signing failed/);
    expect(result.topUp).toEqual({ amount: '500000', batchId: '0xbatch9' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried
    // Nothing was signed, so nothing can have been broadcast. Leaving
    // attemptedPayment unset is what makes both front ends record this as
    // 'refused' rather than 'failed', and only 'failed' draws down the session
    // cap. A signing failure must not spend the user's budget.
    expect(result.attemptedPayment).toBeUndefined();
  });

  it('caps an oversized response body instead of buffering it all (server DoS guard)', async () => {
    // A streamed body larger than the 2 MiB cap must be truncated to an error
    // sentinel rather than OOMing the process.
    const huge = new Uint8Array(1024 * 1024); // 1 MiB chunks
    let emitted = 0;
    const streamRes = {
      status: 200,
      url: URL_UNDER_TEST,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted >= 4) return controller.close(); // 4 MiB total > 2 MiB cap
          emitted++;
          controller.enqueue(huge);
        },
      }),
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(streamRes);

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.body).toEqual({ error: expect.stringMatching(/exceeded/) });
  });

  it('refuses with the funding reason when the hook cannot cover the price, without signing anything', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({ ok: false, reason: 'spending cap reached' }),
    });

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toBe('spending cap reached');
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried with a payment
  });

  it('keeps the top-up trace when funding is refused after a broadcast (reconciliation)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({
        ok: false,
        reason: 'top-up not confirmed after 90000ms',
        amount: '750000',
        batchId: '0xbatch9',
      }),
    });

    expect(result.paid).toBe(false);
    expect(result.topUp).toEqual({ amount: '750000', batchId: '0xbatch9' });
  });

  it('turns a throwing funding hook into a refusal instead of letting it escape', async () => {
    // The hook is what moves the funds, so a bare throw skips both front ends'
    // audit log for money that may already have left. An RPC failure in the
    // balance read is enough to reach here.
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => {
        throw new Error('rpc down');
      },
    });

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toBe('payer funding failed: rpc down');
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried with a payment
  });

  it('keeps the top-up trace when the broadcast returned no call id to confirm', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({
        ok: false,
        reason: 'top-up submitted but no call id returned; cannot confirm it',
        amount: '750000',
      }),
    });

    expect(result.paid).toBe(false);
    // Funds moved with nothing to confirm them by, which is exactly when the
    // ledger row matters most.
    expect(result.topUp).toEqual({ amount: '750000', batchId: undefined });
  });

  it('refuses to pay above the policy cap (no payment attempt)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, { policy: { maxAmountPerPayment: '500' } });

    expect(result.paid).toBe(false);
    expect(result.status).toBe(402);
    expect(result.refusedReason).toMatch(/exceeds maxAmountPerPayment/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried / paid
  });

  it('refuses when the 402 has no PAYMENT-REQUIRED challenge', async () => {
    fetchMock.mockResolvedValueOnce(mockRes({ status: 402, body: '{}' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toMatch(/PAYMENT-REQUIRED/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed accepts entry with a clear reason (no payment attempt)', async () => {
    // payTo is not an address and amount is not an integer string — the schema
    // at the challenge boundary must refuse, not fail deep in the signing path.
    const malformed = b64({
      x402Version: 2,
      resource: { url: URL_UNDER_TEST },
      accepts: [{ ...REQUIREMENT, payTo: 'not-an-address', amount: '1.5' }],
    });
    fetchMock.mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': malformed }, body: '{}' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toMatch(/malformed payment option/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried / paid
  });

  it('echoes the accepted option exactly as advertised (nothing injected or stripped)', async () => {
    // No maxTimeoutSeconds and an unknown future field: the server verifies
    // `accepted` against what it advertised, so validation must not inject
    // defaults into it nor strip fields it does not know.
    const rest = { ...REQUIREMENT } as Partial<X402PaymentRequirement>;
    delete rest.maxTimeoutSeconds;
    const wireEntry = { ...rest, futureField: 'kept' };
    const challenge = b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts: [wireEntry] });
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challenge }, body: '{}' }))
      .mockResolvedValueOnce(mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: '{}' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(true);
    const retryInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    const proof = JSON.parse(Buffer.from(retryInit.headers['PAYMENT-SIGNATURE'], 'base64').toString());
    expect(proof.accepted).toEqual(wireEntry);
  });

  it('refuses a non-integer maxTimeoutSeconds (would crash BigInt in the signer)', async () => {
    // A float/Infinity here reaches BigInt(validBefore) and throws obscurely;
    // the schema must reject it at the boundary instead.
    const malformed = b64({
      x402Version: 2,
      resource: { url: URL_UNDER_TEST },
      accepts: [{ ...REQUIREMENT, maxTimeoutSeconds: 1.5 }],
    });
    fetchMock.mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': malformed }, body: '{}' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toMatch(/malformed payment option/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still pays a valid option when a malformed sibling entry sits beside it', async () => {
    const mixed = b64({
      x402Version: 2,
      resource: { url: URL_UNDER_TEST },
      accepts: [{ ...REQUIREMENT, asset: 'garbage' }, REQUIREMENT],
    });
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': mixed }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(true);
    expect(result.payment?.payTo).toBe(REQUIREMENT.payTo);
  });

  it('surfaces a settlement failure reason + the attempted payment (nonce) instead of throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({
          status: 402,
          headers: { 'PAYMENT-RESPONSE': b64({ success: false, errorReason: 'insufficient_funds' }) },
          body: '{}',
        })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toBe('insufficient_funds');
    // The signed payment must be recoverable — money may have moved in pull mode.
    expect(result.attemptedPayment).toMatchObject({
      amount: '1000',
      payTo: REQUIREMENT.payTo,
      nonce: '0x' + '00'.repeat(32),
    });
    expect(result.payer).toBe(payer.address);
  });

  it('surfaces the re-challenge error when settlement fails without a receipt', async () => {
    // What JAW's own staging server actually does: reject with a fresh 402 whose
    // PAYMENT-REQUIRED.error carries the reason, and no PAYMENT-RESPONSE.
    const reChallenge = b64({
      x402Version: 2,
      error: 'invalid_exact_evm_insufficient_balance',
      resource: { url: URL_UNDER_TEST },
      accepts: [REQUIREMENT],
    });
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': reChallenge }, body: '{}' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toBe('invalid_exact_evm_insufficient_balance');
    expect(result.attemptedPayment?.nonce).toBe('0x' + '00'.repeat(32));
  });

  it('picks the cheapest acceptable option when the server offers several', async () => {
    const dearer: X402PaymentRequirement = { ...REQUIREMENT, amount: '5000' };
    const cheaper: X402PaymentRequirement = { ...REQUIREMENT, amount: '750' };
    const multi = b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts: [dearer, cheaper] });

    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': multi }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(true);
    expect(result.payment?.amount).toBe('750'); // the cheaper option, not the first-listed
  });
});
describe('payAndFetch against a demo-server-shaped x402 endpoint', () => {
  it('reads the price, refills via the hook, pays with the proof, and returns the resource + receipt', async () => {
    const priced = { ...REQUIREMENT, amount: '10000' };
    const challenge = b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts: [priced] });
    const receipt = b64({
      success: true,
      transaction: '0xfeed00000000000000000000000000000000000000000000000000000000beef',
      network: priced.network,
      amount: '10000',
    });

    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challenge }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({
          status: 200,
          headers: { 'PAYMENT-RESPONSE': receipt },
          body: JSON.stringify({ email: 'agent@example.com' }),
        })
      );

    let sawRequirementAmount: string | undefined;
    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async (req) => {
        sawRequirementAmount = req.amount; // the hook sees the real priced requirement
        return { ok: true, amount: '2000000', batchId: '0xtop' };
      },
    });

    // Funding ran before payment, for the advertised price.
    expect(sawRequirementAmount).toBe('10000');
    // The proof carried the exact advertised amount + payTo (server would accept it).
    const retryInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    const proof = JSON.parse(Buffer.from(retryInit.headers['PAYMENT-SIGNATURE'], 'base64').toString());
    expect(proof.accepted.amount).toBe('10000');
    expect(proof.payload.authorization.to.toLowerCase()).toBe(priced.payTo.toLowerCase());
    // Result surfaces the resource, receipt tx, and the top-up trace together.
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ email: 'agent@example.com' });
    expect(result.payment?.txHash).toBe('0xfeed00000000000000000000000000000000000000000000000000000000beef');
    expect(result.topUp).toEqual({ amount: '2000000', batchId: '0xtop' });
  });
});

describe('payAndFetch — dry run', () => {
  it('reports what it would pay without signing or fetching twice', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, url: URL_UNDER_TEST })
    );
    const signing = vi.fn();

    const result = await payAndFetch(URL_UNDER_TEST, { ...payer, pay: signing }, { dryRun: true });

    expect(result.paid).toBe(false);
    expect(result.wouldPay).toMatchObject({ amount: REQUIREMENT.amount, payTo: REQUIREMENT.payTo });
    // The signature is the thing that can move money; it must never be produced.
    expect(signing).not.toHaveBeenCalled();
    // Only the challenge request: no retry with a proof.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never runs the funding hook, which moves user funds', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, url: URL_UNDER_TEST })
    );
    const ensureFunds = vi.fn();

    await payAndFetch(URL_UNDER_TEST, payer, { dryRun: true, ensureFunds });

    expect(ensureFunds).not.toHaveBeenCalled();
  });

  it('still refuses what the policy would refuse, before reporting a price', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, url: URL_UNDER_TEST })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      dryRun: true,
      policy: { maxAmountPerPayment: '1' },
    });

    expect(result.wouldPay).toBeUndefined();
    expect(result.refusedReason).toMatch(/maxAmountPerPayment/);
  });

  it('passes a free resource through as usual', async () => {
    fetchMock.mockResolvedValueOnce(mockRes({ status: 200, body: 'free' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer, { dryRun: true });

    expect(result.status).toBe(200);
    expect(result.wouldPay).toBeUndefined();
    expect(result.paid).toBe(false);
  });
});

describe('payAndFetch — untrusted challenge fields', () => {
  const ESC = String.fromCharCode(0x1b);

  // `network` reached the refusal reason, the ledger, and every later
  // `x402 log`. Constrained at the boundary it cannot carry a payload at all.
  it('refuses a network that is not a CAIP-2 id', async () => {
    const hostile = b64({
      x402Version: 2,
      resource: { url: URL_UNDER_TEST },
      accepts: [{ ...REQUIREMENT, network: `eip155:1${ESC}[2K${ESC}[32mPaid.` }],
    });
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': hostile }, url: URL_UNDER_TEST })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, { dryRun: true });

    expect(result.wouldPay).toBeUndefined();
    expect(result.refusedReason).toContain('CAIP-2');
    expect(result.refusedReason).not.toContain(ESC);
  });

  it('still accepts a well-formed network id', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, url: URL_UNDER_TEST })
    );
    const result = await payAndFetch(URL_UNDER_TEST, payer, { dryRun: true });
    expect(result.wouldPay?.network).toBe(REQUIREMENT.network);
  });
});

describe('payAndFetch, when the response to a signed payment never arrives', () => {
  it('returns the trace instead of throwing, so the ledger still gets the row', async () => {
    // Worst spot in the flow to throw: the top-up moved the user's USDC and the
    // authorization is signed, so a socket error escaping here loses both from
    // the ledger the caps are rebuilt from.
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer, {
      ensureFunds: async () => ({ ok: true, amount: '5000', batchId: '0xbatch7' }),
    });

    expect(result.paid).toBe(false);
    expect(result.refusedReason).toContain('payment sent but the response never arrived');
    expect(result.topUp).toEqual({ amount: '5000', batchId: '0xbatch7' });
    // The nonce is the only way to reconcile an authorization the facilitator
    // may still have broadcast.
    expect(result.attemptedPayment).toBeDefined();
  });
});

/**
 * The ceiling and the charge are the same number under `exact` and different
 * ones under `upto`, so the result carries both. What a cap counts then depends
 * on which of the two, and on whether the payment settled.
 */
describe('payAndFetch spend figures', () => {
  it('records the ceiling it authorized alongside what it paid', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.payment?.authorized).toBe('1000');
    // Recoverable from the ledger later: an ambiguous settlement is reconciled
    // by proving the nonce went unused before this passed.
    expect(result.payment?.deadline).toBeTruthy();
  });

  it('ignores a receipt that claims a smaller charge than the exact scheme signed', async () => {
    // The authorization moved 1000 whatever the server says afterwards. Reading
    // this figure would let it talk our own spend caps down for free.
    const lyingReceipt = b64({ success: true, transaction: RECEIPT_TX, amount: '1' });
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': lyingReceipt }, body: JSON.stringify({ data: 'ok' }) })
      );

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.payment?.amount).toBe('1000');
    expect(result.payment?.authorized).toBe('1000');
  });

  it('carries the ceiling on an attempt whose settlement failed', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' }))
      .mockResolvedValueOnce(mockRes({ status: 500, headers: {}, body: '{}' }));

    const result = await payAndFetch(URL_UNDER_TEST, payer);

    expect(result.paid).toBe(false);
    expect(result.attemptedPayment?.authorized).toBe('1000');
  });

  it('reports no nonce or deadline on a dry run, since nothing was signed', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeHeader }, body: '{}' })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, { dryRun: true });

    expect(result.wouldPay).toMatchObject({ amount: '1000', authorized: '1000' });
    expect(result.wouldPay).not.toHaveProperty('nonce');
    expect(result.wouldPay).not.toHaveProperty('deadline');
  });
});

/**
 * What a server may and may not do to the figure the caps count.
 *
 * The dangerous shape is a 200 with `success: true` and a charge of nothing: no
 * proxy call, no settlement, and the cumulative caps never move while the
 * authorization stays live and spendable until its deadline. Repeat that and the
 * only bound left is the per-payment cap, applied an unlimited number of times.
 */
describe('settledAmountOf', () => {
  const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  const ceiling = '5000000';

  it('reads the settled figure from a receipt that claims a settlement', () => {
    expect(settledAmountOf({ success: true, transaction: TX, amount: '40' }, 'upto', ceiling)).toBe('40');
  });

  /**
   * Locked in as a known limit, not as a guarantee. The hash is shape-checked
   * and never looked up, so a server that fabricates 64 hex characters can
   * report one base unit against the ceiling and keep a live authorization for
   * the rest until the deadline. What bounds that is the on-chain permission,
   * not this function; closing it needs the amount checked against the
   * transaction the receipt names.
   */
  it('cannot tell a real transaction from 64 hex characters', () => {
    const invented = ('0x' + 'f'.repeat(64)) as `0x${string}`;
    expect(settledAmountOf({ success: true, transaction: invented, amount: '1' }, 'upto', ceiling)).toBe('1');
  });

  it('refuses to come down for a receipt that names no transaction', () => {
    expect(settledAmountOf({ success: true, amount: '0' }, 'upto', ceiling)).toBe(ceiling);
  });

  it('refuses to come down for a receipt that does not claim success', () => {
    expect(settledAmountOf({ success: false, transaction: TX, amount: '0' }, 'upto', ceiling)).toBe(ceiling);
  });

  it('refuses to come down for a malformed transaction hash', () => {
    expect(
      settledAmountOf({ success: true, transaction: '0xnope' as `0x${string}`, amount: '0' }, 'upto', ceiling)
    ).toBe(ceiling);
  });

  it('falls back to the ceiling when the receipt omits the amount', () => {
    expect(settledAmountOf({ success: true, transaction: TX }, 'upto', ceiling)).toBe(ceiling);
  });

  it('clamps a receipt claiming more than was authorized', () => {
    expect(settledAmountOf({ success: true, transaction: TX, amount: '9999999' }, 'upto', ceiling)).toBe(ceiling);
  });

  it('never reads the receipt at all under exact, where the amount was fixed', () => {
    expect(settledAmountOf({ success: true, transaction: TX, amount: '1' }, 'exact', '1000')).toBe('1000');
  });

  it('falls back to the ceiling when there is no receipt', () => {
    expect(settledAmountOf(null, 'upto', ceiling)).toBe(ceiling);
  });
});

/**
 * A server may offer both schemes at once. What the client minimises then is not
 * what it expects to pay, it is what it authorizes: an agent cannot predict its
 * own consumption, and a signature is worth its ceiling to anyone holding it.
 */
describe('choosing between schemes', () => {
  // Carries the facilitator every payable upto challenge has; checkPolicy
  // skips the option without one, exactly so the signer never sees it.
  const upto = (amount: string) => ({
    ...REQUIREMENT,
    scheme: 'upto',
    amount,
    extra: { facilitatorAddress: '0x1111111111111111111111111111111111111111' },
  });
  const exact = (amount: string) => ({ ...REQUIREMENT, scheme: 'exact', amount });
  const challengeOf = (...accepts: unknown[]) => b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts });

  const chosen = async (...accepts: unknown[]) => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeOf(...accepts) }, body: '{}' })
    );
    const result = await payAndFetch(URL_UNDER_TEST, payer, { dryRun: true });
    return result.wouldPay;
  };

  /**
   * Every other refusal over this number says "up to" for an `upto` option, and
   * the `--max-amount` one has to as well. Printing the ceiling bare is the one
   * confusion the scheme has to avoid: a ceiling read as a price makes a five
   * dollar authorization on a service charging a fraction of a cent look like a
   * five dollar charge.
   */
  it('names a refused ceiling as a ceiling, --max-amount included', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeOf(upto('5000000')) }, body: '{}' })
    );

    const result = await payAndFetch(URL_UNDER_TEST, payer, { maxAmount: '1000000' });

    expect(result.refusedReason).toContain('amount up to 5000000 exceeds maxAmount');
  });

  it('takes the smaller figure whichever scheme carries it', async () => {
    expect(await chosen(exact('900'), upto('400'))).toMatchObject({ amount: '400' });
    expect(await chosen(upto('900'), exact('400'))).toMatchObject({ amount: '400' });
  });

  /** What the payer was actually asked to sign, which is where the scheme shows. */
  const signed = async (...accepts: unknown[]) => {
    const seen: X402PaymentRequirement[] = [];
    const spy: Payer = {
      address: payer.address,
      pay: async (requirement) => {
        seen.push(requirement);
        return payer.pay(requirement);
      },
    };
    fetchMock
      .mockResolvedValueOnce(
        mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challengeOf(...accepts) }, body: '{}' })
      )
      .mockResolvedValueOnce(mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receiptHeader }, body: '{}' }));
    await payAndFetch(URL_UNDER_TEST, spy);
    return seen[0];
  };

  it('breaks a tie toward the fixed price, whatever order they arrive in', async () => {
    // Equal figures mean different things: one is what will be charged, the
    // other only a bound on it. A server must not be able to dangle a matching
    // ceiling to move us onto the larger authorization.
    expect((await signed(upto('1000'), exact('1000'))).scheme).toBe('exact');
    expect((await signed(exact('1000'), upto('1000'))).scheme).toBe('exact');
  });

  it('does sign the upto option when it is the only one', async () => {
    expect((await signed(upto('1000'))).scheme).toBe('upto');
  });

  it('still refuses a scheme it cannot sign', async () => {
    fetchMock.mockResolvedValueOnce(
      mockRes({
        status: 402,
        headers: { 'PAYMENT-REQUIRED': challengeOf({ ...REQUIREMENT, scheme: 'permit2-batch' }) },
        body: '{}',
      })
    );
    const result = await payAndFetch(URL_UNDER_TEST, payer);
    expect(result.paid).toBe(false);
    expect(result.refusedReason).toContain('unsupported scheme');
  });
});

/**
 * The whole `upto` loop on the client side, in the shape a live settlement
 * actually took on Base Sepolia: a ceiling quoted, a permit signed for it, and
 * a receipt reporting a charge far below it.
 *
 * The payer here is the real builder rather than the stub the other tests use,
 * so what the server receives is the payload that settled on chain.
 */
describe('payAndFetch against an upto endpoint', () => {
  const CEILING = '100000';
  const SETTLED = '1234';
  const FACILITATOR = '0x1111111111111111111111111111111111111111';
  const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

  const uptoRequirement: X402PaymentRequirement = {
    scheme: 'upto',
    network: 'eip155:84532',
    amount: CEILING,
    asset: SEPOLIA_USDC,
    payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    maxTimeoutSeconds: 120,
    extra: { name: 'USDC', version: '2', facilitatorAddress: FACILITATOR },
  };

  const uptoPayer: Payer = {
    address: '0x0000000000000000000000000000000000000001',
    pay: (requirement) =>
      buildUptoPayment(requirement, '0x0000000000000000000000000000000000000001', async () => '0xsig', {
        now: 1_000_000,
        nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
      }),
  };

  it('signs the ceiling, is charged less, and reports both', async () => {
    const challenge = b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts: [uptoRequirement] });
    const receipt = b64({
      success: true,
      transaction: RECEIPT_TX,
      network: 'eip155:84532',
      amount: SETTLED,
    });

    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challenge }, body: '{}' }))
      .mockResolvedValueOnce(
        mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': receipt }, body: JSON.stringify({ data: 'ok' }) })
      );

    let fundedFor: string | undefined;
    const result = await payAndFetch(URL_UNDER_TEST, uptoPayer, {
      ensureFunds: async (req) => {
        // The funder sizes against the ceiling, since that is what settlement
        // may take, not against a charge nobody knows yet.
        fundedFor = req.amount;
        return { ok: true, skipped: true };
      },
    });

    expect(fundedFor).toBe(CEILING);
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ data: 'ok' });
    // What the caps count, and what the ledger will reconcile against.
    expect(result.payment?.amount).toBe(SETTLED);
    expect(result.payment?.authorized).toBe(CEILING);
    expect(result.payment?.txHash).toBe(RECEIPT_TX);
    // The server asked for 120s; the floor holds it open for ten minutes, since
    // settlement has to be mined and not merely submitted.
    expect(result.payment?.deadline).toBe(String(1_000_000 + 600));

    // The proof the server received is a Permit2 authorization for the ceiling,
    // pointed at the pinned proxy and nowhere else.
    const retry = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    const sent = JSON.parse(Buffer.from(retry.headers['PAYMENT-SIGNATURE'], 'base64').toString());
    expect(sent.payload.permit2Authorization.permitted.amount).toBe(CEILING);
    expect(sent.payload.permit2Authorization.spender).toBe(X402_UPTO_PROXY_ADDRESS);
    expect(sent.payload.permit2Authorization.witness.facilitator).toBe(FACILITATOR);
  });

  it('holds the ceiling when the server never says it settled', async () => {
    const challenge = b64({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts: [uptoRequirement] });
    // Success with no transaction: nothing evidences a settlement, so the
    // charge cannot come down and the server spends its own budget.
    const hollow = b64({ success: true, amount: '0' });

    fetchMock
      .mockResolvedValueOnce(mockRes({ status: 402, headers: { 'PAYMENT-REQUIRED': challenge }, body: '{}' }))
      .mockResolvedValueOnce(mockRes({ status: 200, headers: { 'PAYMENT-RESPONSE': hollow }, body: '{}' }));

    const result = await payAndFetch(URL_UNDER_TEST, uptoPayer);

    expect(result.payment?.amount).toBe(CEILING);
  });
});
