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

/**
 * A client whose reads are plain functions. A `vi.fn` hooks every promise it hands
 * back, which marks a dropped rejection as handled and hides what these tests watch for.
 */
function plainClient(getEnsName: (args: { address: string; coinType?: bigint }) => Promise<string | null>) {
  getPublicClient.mockReturnValueOnce({ getEnsName, getEnsText: async () => null } as unknown as ReturnType<
    typeof getPublicClient
  >);
}

/** The rejections nobody handled while `run` was in flight. */
async function unhandledDuring(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const record = (reason: unknown) => seen.push(String(reason));
  process.on('unhandledRejection', record);
  await run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', record);
  return seen;
}

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

  // Both records at once, since a second round trip inside a two second budget
  // for the rarer answer is the wrong trade.
  it('asks a non-mainnet chain for its own record and the default together, and prefers its own', async () => {
    getEnsName.mockImplementation(({ coinType }: { coinType?: bigint }) =>
      Promise.resolve(coinType ? 'base-name.eth' : 'default.eth')
    );

    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 8453 }], KEYED);

    expect(getEnsName).toHaveBeenCalledTimes(2);
    expect(names[identityKey(ADDRESS, 8453)]).toBe('base-name.eth');
  });

  it('falls back to the default record when the chain has none of its own', async () => {
    getEnsName.mockImplementation(({ coinType }: { coinType?: bigint }) =>
      Promise.resolve(coinType ? null : 'default.eth')
    );

    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 8453 }], KEYED);

    expect(names[identityKey(ADDRESS, 8453)]).toBe('default.eth');
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

  // A chain id ENSIP-9 cannot express still gets the default record: what must not
  // happen is the throw taking down every other name asked for in the same batch.
  it('gives a chain whose coin type cannot be expressed the default name, and keeps the rest', async () => {
    getEnsName.mockImplementation(({ coinType }: { coinType?: bigint }) =>
      Promise.resolve(coinType ? 'scoped.eth' : 'default.eth')
    );

    const names = await reverseResolveAddresses(
      [
        { address: ADDRESS, chainId: 11297108109 },
        { address: OTHER, chainId: 1 },
      ],
      KEYED
    );

    expect(names[identityKey(ADDRESS, 11297108109)]).toBe('default.eth');
    expect(names[identityKey(OTHER, 1)]).toBe('default.eth');
  });

  it('omits an address the chain could not answer for, and never rejects', async () => {
    getEnsName.mockRejectedValue(new Error('rpc down'));

    await expect(reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED)).resolves.toEqual({});
  });

  // A node that did not answer is not an answer. With the multicall batching on,
  // one 5xx rejects every caller in the batch, so remembering it as "no name"
  // would put hex on the whole dialog for the window.
  it('does not remember a node that failed to answer', async () => {
    getEnsName.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue('arrived.eth');

    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);
    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(names[identityKey(ADDRESS, 1)]).toBe('arrived.eth');
  });
});

// Off mainnet the default record is read up front and only awaited when the chain's
// own has none, so on the paths that drop it its rejection has to stay handled.
describe('the default record read nobody waits for', () => {
  it('keeps its rejection handled when the chain-scoped record answers', async () => {
    plainClient(({ coinType }) =>
      coinType ? Promise.resolve('base-name.eth') : Promise.reject(new Error('rpc down'))
    );

    let names: Record<string, string> = {};
    const unhandled = await unhandledDuring(async () => {
      names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 8453 }], KEYED);
    });

    expect(names[identityKey(ADDRESS, 8453)]).toBe('base-name.eth');
    expect(unhandled).toEqual([]);
  });

  // The normal path for an offchain name off mainnet: both records revert, the
  // scoped one is rethrown for the service and the default one is left behind.
  it('keeps it handled when both records revert offchain', async () => {
    plainClient(() => Promise.reject(offchainLookup));
    const fetchMock = stubFetch(serviceBody(ADDRESS, 'offchain.justan.id'));

    let result: Record<string, { name: string }> = {};
    const unhandled = await unhandledDuring(async () => {
      result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 8453 }], KEYED);
    });

    expect(unhandled).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result[identityKey(ADDRESS, 8453)]?.name).toBe('offchain.justan.id');
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

describe('what the memory is keyed on', () => {
  // A different url is a different backend and, keyless, a different answer: the
  // offchain names it refuses must not be inherited by a call that carries a key.
  it('does not serve one rpc url the answer another one got', async () => {
    getEnsName.mockRejectedValue(offchainLookup);
    stubFetch(serviceBody(ADDRESS, 'offchain.justan.id'));

    await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYLESS);
    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(result[identityKey(ADDRESS, 1)]).toEqual({ name: 'offchain.justan.id' });
  });

  // A name remembered without its avatar would otherwise be handed to a caller
  // that asked for one.
  it('does not serve a caller asking for an avatar the answer that had none', async () => {
    getEnsName.mockResolvedValue('withavatar.eth');
    getEnsText.mockResolvedValue('https://cdn.example/a.png');

    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], KEYED);
    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(result[identityKey(ADDRESS, 1)]?.avatar).toBe(ensMetadataAvatarUrl('withavatar.eth'));
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

// The service echoes the address alone, with the chain suffix stripped, so two
// chains asked in one request would collapse onto the same slot and one of them
// would take the other's name.
describe('offchain names across two chains', () => {
  it('asks once per chain and keeps each name on its own', async () => {
    getEnsName.mockRejectedValue(offchainLookup);
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        serviceBody(
          ADDRESS,
          url.includes('eip155%3A1&') || url.includes('eip155:1&') ? 'main.justan.id' : 'base.justan.id'
        ),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await reverseResolveWithAvatars(
      [
        { address: ADDRESS, chainId: 1 },
        { address: ADDRESS, chainId: 8453 },
      ],
      KEYED
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result[identityKey(ADDRESS, 1)]?.name).toBe('main.justan.id');
    expect(result[identityKey(ADDRESS, 8453)]?.name).toBe('base.justan.id');
  });

  // One request per chain means one failure per chain: the name that did arrive is
  // kept, and the addresses of the chain that failed are asked again.
  it('keeps the chain that answered when another chain request fails', async () => {
    getEnsName.mockRejectedValue(offchainLookup);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('eip155%3A1&')) throw new Error('network down');
        return { ok: true, json: async () => serviceBody(ADDRESS, 'base.justan.id') };
      })
    );

    const result = await reverseResolveWithAvatars(
      [
        { address: ADDRESS, chainId: 1 },
        { address: ADDRESS, chainId: 8453 },
      ],
      KEYED
    );

    expect(result[identityKey(ADDRESS, 8453)]?.name).toBe('base.justan.id');
    expect(result[identityKey(ADDRESS, 1)]).toBeUndefined();
  });

  // Everything in that answer is off the wire, so a slot without an address
  // leaves itself out rather than taking the batch down with it.
  it('keeps the batch when the service answers with a malformed slot', async () => {
    getEnsName.mockRejectedValue(offchainLookup);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: { data: [null, { address: ADDRESS, name: 'fine.justan.id' }] } }),
      }))
    );

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], KEYED);

    expect(result[identityKey(ADDRESS, 1)]?.name).toBe('fine.justan.id');
  });
});
