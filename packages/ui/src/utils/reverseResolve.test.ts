import { afterEach, describe, expect, it, vi } from 'vitest';
import { toCoinType } from 'viem';
import { identityKey, reverseResolveAddresses, reverseResolveWithAvatars } from './reverseResolve';

const ADDRESS = '0xfAbc9dDe6d43b39E087122A80f05E80615110b65';
const EMOJI_ADDRESS = '0x00000000000000000000000000000000000000aa';
const BASE = 8453;
const RPC_URL = 'http://rpc.test';

/** One slot of the reverse API's answer, as it comes back for an `@eip155:<chainId>` address. */
function slot(address: string, name: string, chainId: number, texts?: { key: string; value: string }[]) {
  return {
    address: address.toLowerCase(),
    name,
    coinType: Number(toCoinType(chainId)),
    records: texts ? { records: { texts } } : null,
  };
}

/** `data` is an object for a single-address request and an array for a batch. */
function stubFetch(data: unknown) {
  const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { data } }) });
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reverseResolveWithAvatars', () => {
  it('routes a name with an avatar record through the ENS metadata proxy (never the raw record URL)', async () => {
    stubFetch(
      slot(ADDRESS, 'ghadi20.justan.id', 1, [
        { key: 'avatar', value: 'https://cdn.justaname.id/avatar/ghadi.justan.id.png' },
      ])
    );

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], RPC_URL);

    expect(result[identityKey(ADDRESS, 1)]).toEqual({
      name: 'ghadi20.justan.id',
      avatar: 'https://metadata.ens.domains/mainnet/avatar/ghadi20.justan.id',
    });
  });

  it('omits avatar when the name has no avatar record', async () => {
    stubFetch(slot(ADDRESS, 'ghadi20.justan.id', 1, [{ key: 'email', value: 'ghadi@justalab.co' }]));

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], RPC_URL);

    expect(result[identityKey(ADDRESS, 1)].avatar).toBeUndefined();
  });

  it('URL-encodes the name segment in the proxy URL', async () => {
    stubFetch(slot(EMOJI_ADDRESS, '🦊.justan.id', 1, [{ key: 'avatar', value: 'ipfs://whatever' }]));

    const result = await reverseResolveWithAvatars([{ address: EMOJI_ADDRESS, chainId: 1 }], RPC_URL);

    expect(result[identityKey(EMOJI_ADDRESS, 1)].avatar).toBe(
      `https://metadata.ens.domains/mainnet/avatar/${encodeURIComponent('🦊.justan.id')}`
    );
  });
});

describe('one name per address and chain', () => {
  // The same address can carry a different name on each chain. Filed by address alone
  // the two answers landed on one entry, and whichever came back last was rendered on
  // both rows of a batch that spanned two chains.
  it('keeps both answers when one address is asked on two chains', async () => {
    stubFetch([slot(ADDRESS, 'mainnet-name.eth', 1), slot(ADDRESS, 'base-name.eth', BASE)]);

    const names = await reverseResolveAddresses(
      [
        { address: ADDRESS, chainId: 1 },
        { address: ADDRESS, chainId: BASE },
      ],
      RPC_URL
    );

    expect(names[identityKey(ADDRESS, 1)]).toBe('mainnet-name.eth');
    expect(names[identityKey(ADDRESS, BASE)]).toBe('base-name.eth');
  });

  it('still asks for both in a single request', async () => {
    const mockFetch = stubFetch([slot(ADDRESS, 'mainnet-name.eth', 1), slot(ADDRESS, 'base-name.eth', BASE)]);

    await reverseResolveAddresses(
      [
        { address: ADDRESS, chainId: 1 },
        { address: ADDRESS, chainId: BASE },
      ],
      RPC_URL
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.getAll('address')).toEqual([`${ADDRESS}@eip155:1`, `${ADDRESS}@eip155:${BASE}`]);
  });

  // A slot with no coinType failed before the lookup and has no chain to be filed
  // under. Dropping it renders the address as hex; placing it by position would put a
  // name on a row it was not read for.
  it('drops a slot whose chain cannot be placed', async () => {
    stubFetch([{ address: ADDRESS.toLowerCase(), name: 'somewhere.eth', coinType: null, records: null }]);

    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], RPC_URL);

    expect(names).toEqual({});
  });
});
