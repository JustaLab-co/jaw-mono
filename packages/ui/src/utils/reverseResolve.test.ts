import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEnsName = vi.fn();
const getEnsText = vi.fn();
const createPublicClient = vi.fn(() => ({ getEnsName, getEnsText }));

vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: (...args: unknown[]) => createPublicClient(...(args as [])),
}));

const { reverseResolveWithAvatars, reverseResolveAddresses, ensMetadataAvatarUrl } = await import('./reverseResolve');

const ADDRESS = '0xfAbc9dDe6d43b39E087122A80f05E80615110b65';
const LOWER = ADDRESS.toLowerCase();

beforeEach(() => {
  getEnsName.mockReset();
  getEnsText.mockReset();
  createPublicClient.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reverseResolveWithAvatars', () => {
  // The record's value is never rendered: a host with a bad certificate on the
  // signing page taints it and blocks the passkey ceremony in strict browsers.
  it('routes a name with an avatar record through the ENS metadata proxy', async () => {
    getEnsName.mockResolvedValue('ghadi20.justan.id');
    getEnsText.mockResolvedValue('https://cdn.justaname.id/avatar/ghadi.png');

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], 'http://rpc.test');

    expect(result[LOWER]).toEqual({
      name: 'ghadi20.justan.id',
      avatar: ensMetadataAvatarUrl('ghadi20.justan.id'),
    });
    expect(JSON.stringify(result)).not.toContain('cdn.justaname.id');
  });

  it('omits the avatar when the name carries no record', async () => {
    getEnsName.mockResolvedValue('noavatar.eth');
    getEnsText.mockResolvedValue(null);

    const result = await reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], 'http://rpc.test');

    expect(result[LOWER]).toEqual({ name: 'noavatar.eth' });
  });

  it('encodes the name in the proxy url', () => {
    expect(ensMetadataAvatarUrl('a b/c.eth')).toBe('https://metadata.ens.domains/mainnet/avatar/a%20b%2Fc.eth');
  });
});

describe('reverse resolution over the chain', () => {
  it('asks a non-mainnet chain under its own coin type, then the default record', async () => {
    getEnsName.mockResolvedValueOnce(null).mockResolvedValueOnce('fallback.eth');

    const names = await reverseResolveAddresses([{ address: ADDRESS, chainId: 8453 }], 'http://rpc.test');

    expect(getEnsName).toHaveBeenCalledTimes(2);
    expect(getEnsName.mock.calls[0][0]).toMatchObject({ address: ADDRESS, coinType: expect.anything() });
    expect(getEnsName.mock.calls[1][0]).toEqual({ address: ADDRESS });
    expect(names[LOWER]).toBe('fallback.eth');
  });

  it('asks mainnet once, with no coin type', async () => {
    getEnsName.mockResolvedValue('direct.eth');

    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], 'http://rpc.test');

    expect(getEnsName).toHaveBeenCalledTimes(1);
    expect(getEnsName.mock.calls[0][0]).toEqual({ address: ADDRESS });
  });

  // One entry per address and chain, so a screen listing the same counterparty
  // twice does not ask twice.
  it('asks once for an address repeated across the inputs', async () => {
    getEnsName.mockResolvedValue('once.eth');

    await reverseResolveAddresses(
      [
        { address: ADDRESS, chainId: 1 },
        { address: ADDRESS.toLowerCase(), chainId: 1 },
      ],
      'http://rpc.test'
    );

    expect(getEnsName).toHaveBeenCalledTimes(1);
  });

  // Names are decoration on these screens: the address and the amounts do not
  // depend on them, so a node that will not answer leaves them out.
  it('omits an address the chain could not answer for, and never rejects', async () => {
    getEnsName.mockRejectedValue(new Error('rpc down'));

    await expect(reverseResolveWithAvatars([{ address: ADDRESS, chainId: 1 }], 'http://rpc.test')).resolves.toEqual({});
  });

  it('keeps one client per rpc url', async () => {
    getEnsName.mockResolvedValue('cached.eth');

    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], 'http://rpc.one');
    await reverseResolveAddresses([{ address: ADDRESS, chainId: 1 }], 'http://rpc.one');

    expect(createPublicClient).toHaveBeenCalledTimes(1);
  });
});
