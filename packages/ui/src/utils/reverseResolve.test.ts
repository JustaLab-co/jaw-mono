import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnsName = vi.fn();
const getEnsText = vi.fn();
const getPublicClient = vi.fn(() => ({ getEnsName, getEnsText }));

vi.mock('./publicClient', () => ({ getPublicClient: (...args: unknown[]) => getPublicClient(...(args as [])) }));

const { reverseResolveWithAvatars, reverseResolveAddresses, ensMetadataAvatarUrl, identityKey, clearIdentityMemory } =
  await import('./reverseResolve');

const ADDRESS = '0xfAbc9dDe6d43b39E087122A80f05E80615110b65';
const OTHER = '0x1111111111111111111111111111111111111111';
const KEYED = 'https://api.justaname.id/proxy/v1/rpc?chainId=1&api-key=k1';
const KEYLESS = 'https://api.justaname.id/proxy/v1/rpc?chainId=1';

/** What viem throws for an offchain resolver when the client refuses to follow the lookup. */
const offchainLookup = Object.assign(new Error('reverted'), { cause: { data: '0x556f1830deadbeef' } });

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function serviceBody(address: string, name: string | null, texts?: { key: string }[]) {
  return { result: { data: { address, name, records: texts ? { records: { texts } } : null } } };
}

beforeEach(() => {
  clearIdentityMemory();
  getEnsName.mockReset();
  getEnsText.mockReset();
  getPublicClient.mockClear();
  vi.unstubAllGlobals();
});

describe('names read over the chain', () => {
  it('resolves and routes the avatar through the ENS metadata proxy', async () => {
    getEnsName.mockResolvedValue('ghadi20.justan.id');
    getEnsText.mockResolvedValue('https://cdn.justaname.id/avatar/ghadi.png');

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(result[identityKey(ADDRESS, 1)]).toEqual({
      name: 'ghadi20.justan.id',
      avatar: ensMetadataAvatarUrl('ghadi20.justan.id'),
    });
    expect(JSON.stringify(result)).not.toContain('cdn.justaname.id');
  });

  it('asks a non-mainnet chain under its own coin type, then the default record', async () => {
    getEnsName.mockResolvedValueOnce(null).mockResolvedValueOnce('fallback.eth');

    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 8453 }], KEYED);

    expect(getEnsName.mock.calls[0][0]).toMatchObject({ coinType: expect.anything() });
    expect(getEnsName.mock.calls[1][0]).toEqual({ address: ADDRESS });
    expect(names[identityKey(ADDRESS, 8453)]).toBe('fallback.eth');
  });

  // The same address can carry a different name per chain, and the row that shows
  // it knows which chain it is on.
  it('keeps a name per chain rather than letting the last one win', async () => {
    // Keyed on the argument, not on call order: the two inputs resolve in parallel.
    getEnsName.mockImplementation(({ coinType }: { coinType?: bigint }) =>
      Promise.resolve(coinType ? 'base-name.eth' : 'main-name.eth')
    );

    const names = await reverseResolveAddresses(
      [
        { address: ADDRESS, chainId: 8453 },
        { address: ADDRESS, chainId: 1 },
      ],
      KEYED
    );

    expect(names[identityKey(ADDRESS, 8453)]).toBe('base-name.eth');
    expect(names[identityKey(ADDRESS, 1)]).toBe('main-name.eth');
  });

  it('leaves out a chain whose coin type cannot be expressed, and keeps the rest', async () => {
    getEnsName.mockResolvedValue('kept.eth');

    const names = await reverseResolveAddresses(
      [
        { address: ADDRESS, chainId: 11297108109 },
        { address: OTHER, chainId: 1 },
      ],
      KEYED
    );

    expect(names[identityKey(OTHER, 1)]).toBe('kept.eth');
  });

  it('omits an address the chain could not answer for, and never rejects', async () => {
    getEnsName.mockRejectedValue(new Error('rpc down'));

    await expect(reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED)).resolves.toEqual({});
  });
});

describe('names whose resolver is offchain', () => {
  // Following that lookup from the page means fetching a host the resolver names,
  // so a server that may do it answers instead.
  it('asks the name service when the chain says the resolver is offchain', async () => {
    getEnsName.mockRejectedValue(offchainLookup);
    const fetchMock = stubFetch(serviceBody(ADDRESS, 'offchain.justan.id', [{ key: 'avatar' }]));

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/ens/v2/reverse');
    expect(result[identityKey(ADDRESS, 1)]).toEqual({
      name: 'offchain.justan.id',
      avatar: ensMetadataAvatarUrl('offchain.justan.id'),
    });
  });

  // The service resolves on the key inside the url and refuses without one, so
  // the hop is not worth making.
  it('does not ask the service when the url carries no key', async () => {
    getEnsName.mockRejectedValue(offchainLookup);
    const fetchMock = stubFetch(serviceBody(ADDRESS, 'offchain.justan.id'));

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYLESS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  // A node that did not answer is ours to retry, not the service's to absorb.
  it('does not ask the service for a plain rpc failure', async () => {
    getEnsName.mockRejectedValue(new Error('rpc down'));
    const fetchMock = stubFetch(serviceBody(ADDRESS, 'offchain.justan.id'));

    await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what is remembered', () => {
  it('asks once for an address it already resolved', async () => {
    getEnsName.mockResolvedValue('once.eth');

    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);
    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(getEnsName).toHaveBeenCalledTimes(1);
  });

  // A name that does not exist will not start existing within the window, and the
  // dialogs re-render often enough for this to be the difference between one ask
  // and one per paint.
  it('remembers that there was no name', async () => {
    getEnsName.mockResolvedValue(null);

    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);
    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(getEnsName).toHaveBeenCalledTimes(1);
    expect(names).toEqual({});
  });

  it('forgets after the window', async () => {
    getEnsName.mockResolvedValue('later.eth');
    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);

    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(getEnsName).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});

describe('the time it is given', () => {
  // Names are decoration: what has not arrived by the deadline is left out and the
  // address renders as hex, and nothing is remembered, so the next dialog asks again.
  it('gives up on a resolution that outlasts its budget, and remembers nothing', async () => {
    vi.useFakeTimers();
    getEnsName.mockReturnValue(new Promise(() => undefined));

    const pending = reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await pending).toEqual({});
    vi.useRealTimers();

    getEnsName.mockResolvedValue('arrived.eth');
    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);
    expect(names[identityKey(ADDRESS, 1)]).toBe('arrived.eth');
  });
});
