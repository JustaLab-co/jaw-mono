import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverServices } from './discover.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// No `body` stream on the mock, so readCappedJson falls back to text().
const mockJson = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    body: null,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// URL the mock was called with, for asserting query params.
const calledUrl = (): URL => new URL(fetchMock.mock.calls[0][0] as string);

describe('discoverServices — search mode', () => {
  it('Given a query, When searching, Then it calls the Bazaar search endpoint with the params and maps the results', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({
        searchMethod: 'hybrid',
        partialResults: false,
        resources: [
          {
            resource: 'https://api.justaname.id/ens/v2/resolve',
            serviceName: 'JustaName ENS Resolver',
            description: 'Resolve ENS',
            tags: ['ens', 'identity'],
            x402Version: 2,
            accepts: [
              {
                scheme: 'exact',
                network: 'eip155:8453',
                amount: '1000',
                asset: USDC_BASE,
                payTo: '0xabc',
                maxTimeoutSeconds: 60,
              },
            ],
            extensions: {
              bazaar: { info: { input: { type: 'http', method: 'GET', queryParams: { ens: 'vitalik.eth' } } } },
            },
            quality: { l30DaysTotalCalls: 13, l30DaysUniquePayers: 7, lastCalledAt: '2026-08-02T00:00:00Z' },
          },
        ],
      })
    );

    const result = await discoverServices({ query: 'ens resolver' });

    const url = calledUrl();
    expect(url.pathname).toContain('/discovery/search');
    expect(url.searchParams.get('query')).toBe('ens resolver');
    expect(url.searchParams.get('network')).toBe('eip155:8453');
    expect(url.searchParams.get('limit')).toBe('10');

    expect(result.mode).toBe('search');
    expect(result.count).toBe(1);
    expect(result.searchMethod).toBe('hybrid');
    const svc = result.services[0];
    expect(svc.name).toBe('JustaName ENS Resolver');
    expect(svc.url).toBe('https://api.justaname.id/ens/v2/resolve');
    expect(svc.tags).toEqual(['ens', 'identity']);
    expect(svc.price).toEqual({
      amount: '1000',
      kind: 'price',
      asset: USDC_BASE,
      network: 'eip155:8453',
      payTo: '0xabc',
      scheme: 'exact',
      maxTimeoutSeconds: 60,
      approxUsd: 0.001,
    });
    expect(svc.howToCall).toEqual({ type: 'http', method: 'GET', queryParams: { ens: 'vitalik.eth' } });
    expect(svc.trust).toEqual({ curated: null, calls30d: 13, payers30d: 7, lastCalledAt: '2026-08-02T00:00:00Z' });
  });

  // The catalogue is a remote answer, and the network in it is whatever the
  // server wrote. Looking it up against a plain object handed back a prototype
  // member, and reading an address off it took down the whole call.
  it('Given a catalogue entry naming a prototype member as its network, When mapping, Then it maps as unpriced instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({
        resources: [
          {
            resource: 'https://api.example/thing',
            accepts: [{ scheme: 'exact', network: 'constructor', amount: '1000', asset: USDC_BASE, payTo: '0xabc' }],
          },
        ],
      })
    );

    const result = await discoverServices({ query: 'x' });

    expect(result.count).toBe(1);
    expect(result.services[0].price?.network).toBe('constructor');
    expect(result.services[0].price?.approxUsd).toBeNull();
  });

  it('Given optional filters, When searching, Then maxUsdPrice, curatedOnly and a clamped limit are forwarded', async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ resources: [] }));

    await discoverServices({ query: 'x', maxUsdPrice: '0.01', curatedOnly: true, limit: 999, network: 'eip155:84532' });

    const url = calledUrl();
    expect(url.searchParams.get('maxUsdPrice')).toBe('0.01');
    expect(url.searchParams.get('curatedOnly')).toBe('true');
    expect(url.searchParams.get('network')).toBe('eip155:84532');
    // limit clamped to the Bazaar max of 20.
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('Given multiple accepts entries, When mapping, Then it picks the cheapest option on the preferred network', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({
        resources: [
          {
            resource: 'https://svc.example/x',
            accepts: [
              // Cheaper, but on another chain — must NOT win over the Base option.
              { scheme: 'exact', network: 'eip155:137', amount: '500', asset: '0xdef', payTo: '0x1' },
              { scheme: 'exact', network: 'eip155:8453', amount: '3000', asset: USDC_BASE, payTo: '0x2' },
              { scheme: 'exact', network: 'eip155:8453', amount: '2000', asset: USDC_BASE, payTo: '0x3' },
            ],
          },
        ],
      })
    );

    const result = await discoverServices({ query: 'x' });

    expect(result.services[0].price?.amount).toBe('2000');
    expect(result.services[0].price?.network).toBe('eip155:8453');
    expect(result.services[0].price?.approxUsd).toBe(0.002);
  });

  it('Given no accepts entry on the preferred network, When mapping, Then it falls back to the cheapest overall', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({
        resources: [
          {
            resource: 'https://svc.example/y',
            accepts: [
              { scheme: 'exact', network: 'eip155:137', amount: '900', asset: '0xdef', payTo: '0x1' },
              { scheme: 'exact', network: 'eip155:137', amount: '400', asset: '0xdef', payTo: '0x2' },
            ],
          },
        ],
      })
    );

    const result = await discoverServices({ query: 'y' });

    expect(result.services[0].price?.amount).toBe('400');
    // Unknown asset on a non-registry chain → no USD estimate.
    expect(result.services[0].price?.approxUsd).toBeNull();
  });
});

describe('discoverServices — defensive mapping of untrusted data', () => {
  it('Given a resource with no serviceName/tags and a malformed accepts entry, When mapping, Then missing fields are null and bad options are skipped', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({
        resources: [
          {
            resource: 'https://svc.example/z',
            // no serviceName, no tags, no quality, no extensions
            accepts: [
              { scheme: 'exact', network: 'eip155:8453', amount: 'not-a-number', asset: USDC_BASE, payTo: '0x1' },
              { scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: USDC_BASE, payTo: '0x2' },
            ],
          },
        ],
      })
    );

    const result = await discoverServices({ query: 'z' });
    const svc = result.services[0];
    expect(svc.name).toBeNull();
    expect(svc.tags).toBeNull();
    expect(svc.howToCall).toBeUndefined();
    expect(svc.trust).toEqual({ curated: null, calls30d: null, payers30d: null, lastCalledAt: null });
    // The malformed 'not-a-number' amount is dropped; the valid one is chosen.
    expect(svc.price?.amount).toBe('5000');
  });

  it('Given a resource with zero usable accepts entries, When mapping, Then price is null', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({ resources: [{ resource: 'https://svc.example/q', accepts: [{ scheme: 'exact' }] }] })
    );

    const result = await discoverServices({ query: 'q' });
    expect(result.services[0].price).toBeNull();
  });
});

describe('discoverServices — merchant mode', () => {
  it('Given both query and payTo, When called, Then payTo wins (merchant endpoint, query ignored)', async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ resources: [] }));

    await discoverServices({ query: 'ens', payTo: '0xabc' });

    const url = calledUrl();
    expect(url.pathname).toContain('/discovery/merchant');
    expect(url.searchParams.get('payTo')).toBe('0xabc');
    expect(url.searchParams.get('query')).toBeNull();
  });

  it('Given a payTo, When called, Then it hits the merchant endpoint and reports merchant mode', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson({
        payTo: '0xc529edd6d47c60923902514c7c0b3993ae42c2ec',
        resources: [
          { resource: 'https://api.justaname.id/ens/v2/resolve', serviceName: 'JustaName ENS Resolver', accepts: [] },
          {
            resource: 'https://api.justaname.id/ens/v2/reverse',
            serviceName: 'JustaName ENS Reverse Resolver',
            accepts: [],
          },
        ],
      })
    );

    const result = await discoverServices({ payTo: '0xc529edd6d47c60923902514c7c0b3993ae42c2ec' });

    const url = calledUrl();
    expect(url.pathname).toContain('/discovery/merchant');
    expect(url.searchParams.get('payTo')).toBe('0xc529edd6d47c60923902514c7c0b3993ae42c2ec');
    expect(result.mode).toBe('merchant');
    expect(result.count).toBe(2);
    expect(result.services.map((s) => s.name)).toEqual(['JustaName ENS Resolver', 'JustaName ENS Reverse Resolver']);
  });
});

describe('discoverServices — errors and hostile shapes', () => {
  it('Given a non-OK response, When called, Then it throws with the status', async () => {
    fetchMock.mockResolvedValueOnce(mockJson({}, false, 503));
    await expect(discoverServices({ query: 'x' })).rejects.toThrow('HTTP 503');
  });

  it('Given a non-array resources field, When called, Then it degrades to an empty result instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ resources: 'not-an-array' }));
    const result = await discoverServices({ query: 'x' });
    expect(result.count).toBe(0);
    expect(result.services).toEqual([]);
  });

  it('Given a response body over the size cap, When streamed, Then it aborts with a size-cap error', async () => {
    // A stream that keeps yielding 512 KiB chunks; the reader must cancel and
    // throw once the running total passes the 1 MiB cap (on the 3rd chunk).
    const cancel = vi.fn(async () => undefined);
    const chunk = new Uint8Array(512 * 1024);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: chunk }),
          cancel,
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response);

    await expect(discoverServices({ query: 'x' })).rejects.toThrow('size cap');
    expect(cancel).toHaveBeenCalled();
  });
});

/**
 * A catalog is read to compare numbers, and under `upto` the number is a
 * ceiling. An agent that reads it as a price picks the wrong service and
 * authorizes far more than it meant to.
 */
describe('discoverServices — a ceiling is not a price', () => {
  const service = (accepts: unknown[]) => ({
    resources: [{ resource: 'https://api.example.com/x', accepts }],
  });
  const option = (o: Record<string, unknown>) => ({
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '1000',
    asset: USDC_BASE,
    payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    ...o,
  });

  it('marks an upto option as a ceiling', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(service([option({ scheme: 'upto', amount: '5000000' })])));

    const { services } = await discoverServices({ query: 'x' });

    expect(services[0].price?.kind).toBe('ceiling');
    expect(services[0].price?.scheme).toBe('upto');
  });

  it('breaks a tie toward the option that cannot grow', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(service([option({ scheme: 'upto' }), option({ scheme: 'exact' })])));

    const { services } = await discoverServices({ query: 'x' });

    expect(services[0].price?.kind).toBe('price');
  });

  it('still takes the smaller figure whichever kind carries it', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson(service([option({ amount: '9000' }), option({ scheme: 'upto', amount: '400' })]))
    );

    const { services } = await discoverServices({ query: 'x' });

    expect(services[0].price?.amount).toBe('400');
    expect(services[0].price?.kind).toBe('ceiling');
  });
});

/**
 * Discovery decides which service an agent points its budget at, so what it
 * refuses to list matters as much as what it ranks first.
 */
describe('discoverServices — what it declines to advertise', () => {
  const service = (accepts: unknown[]) => ({
    resources: [{ resource: 'https://api.example.com/x', accepts }],
  });
  const option = (o: Record<string, unknown>) => ({
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '1000',
    asset: USDC_BASE,
    payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    ...o,
  });

  // Listed, it would be the cheap option an agent chooses the service for, and
  // then the payment path would refuse it and pay the other one instead.
  it('skips an option in a scheme the payment path cannot sign', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson(service([option({ scheme: 'exact-evm', amount: '100' }), option({ scheme: 'upto', amount: '5000000' })]))
    );

    const { services } = await discoverServices({ query: 'x' });

    expect(services[0].price?.amount).toBe('5000000');
    expect(services[0].price?.kind).toBe('ceiling');
  });

  it('reports no price when every option is unpayable', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(service([option({ scheme: 'permit2-batch' })])));

    const { services } = await discoverServices({ query: 'x' });

    expect(services[0].price).toBeNull();
  });

  // The Bazaar filters on whichever option matched its query; we go on to pick
  // a different one, so the cap has to be applied to what we selected.
  it('drops a service whose selected option is over the cap', async () => {
    fetchMock.mockResolvedValueOnce(mockJson(service([option({ scheme: 'upto', amount: '5000000' })])));

    const { services } = await discoverServices({ query: 'x', maxUsdPrice: '0.01' });

    expect(services).toHaveLength(0);
  });

  it('keeps one it cannot value, rather than hiding the unfamiliar', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJson(service([option({ asset: '0x1234567890123456789012345678901234567890' })]))
    );

    const { services } = await discoverServices({ query: 'x', maxUsdPrice: '0.000001' });

    expect(services).toHaveLength(1);
    expect(services[0].price?.approxUsd).toBeNull();
  });
});

/**
 * The cap arrives as free text a model wrote, and the two ways of getting it
 * wrong fail quietly in opposite directions unless they are refused: an empty
 * string filters everything away, a currency symbol disables the filter while
 * the caller believes one is applied.
 */
describe('discoverServices — the price cap is a number or an error', () => {
  it('refuses an empty cap instead of reading it as zero', async () => {
    await expect(discoverServices({ query: 'x', maxUsdPrice: '' })).rejects.toThrow(/non-negative number/);
  });

  it('refuses a cap with a currency symbol instead of ignoring it', async () => {
    await expect(discoverServices({ query: 'x', maxUsdPrice: '$0.01' })).rejects.toThrow(/non-negative number/);
  });

  it('refuses a negative cap', async () => {
    await expect(discoverServices({ query: 'x', maxUsdPrice: '-1' })).rejects.toThrow(/non-negative number/);
  });

  it('takes a plain number', async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ resources: [] }));
    await expect(discoverServices({ query: 'x', maxUsdPrice: '0.01' })).resolves.toBeTruthy();
  });
});
