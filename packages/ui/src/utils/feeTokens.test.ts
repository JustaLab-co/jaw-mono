import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { handleGetAssetsRequest } from '@jaw.id/core';
import { fetchTokenBalance } from './tokenBalance';
import { loadFeeTokenOptions } from './feeTokens';

vi.mock('@jaw.id/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jaw.id/core')>()),
  handleGetAssetsRequest: vi.fn(),
}));

vi.mock('./tokenBalance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tokenBalance')>()),
  fetchTokenBalance: vi.fn(),
}));

const dynamic = { supported: true, mode: 'dynamic' as const };

describe('loadFeeTokenOptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns no options without error when a dynamic wallet holds no assets', async () => {
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({ '0x2105': [] });

    await expect(
      loadFeeTokenOptions({
        capability: dynamic,
        account: '0x1111111111111111111111111111111111111111',
        chainId: 8453,
        rpcUrl: 'https://rpc.example',
      })
    ).resolves.toEqual([]);
  });

  it('maps dynamically discovered balances without requiring seeded logo data', async () => {
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({
      '0x2105': [
        {
          address: null,
          balance: '0x1',
          metadata: { decimals: 18, name: 'Ether', symbol: 'ETH' },
          type: 'native',
        },
        {
          address: '0x2222222222222222222222222222222222222222',
          balance: '0xf4240',
          metadata: { decimals: 6, name: 'USD Coin', symbol: 'USDC' },
          type: 'erc20',
        },
      ],
    });

    const result = await loadFeeTokenOptions({
      capability: dynamic,
      account: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
      rpcUrl: 'https://rpc.example',
      apiKey: 'key',
    });

    expect(result).toEqual([
      expect.objectContaining({ address: zeroAddress, symbol: 'ETH', balance: 1n }),
      expect.objectContaining({
        address: '0x2222222222222222222222222222222222222222',
        symbol: 'USDC',
        balance: 1_000_000n,
      }),
    ]);
    expect(result.every((token) => !Object.hasOwn(token, 'logoURI'))).toBe(true);
  });

  it('caps dynamically discovered ERC-20 candidates at the paymaster request limit', async () => {
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({
      '0x2105': Array.from({ length: 25 }, (_, index) => ({
        address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
        balance: '0x1',
        metadata: { decimals: 18, name: `Token ${index}`, symbol: `T${index}` },
        type: 'erc20',
      })),
    });

    const result = await loadFeeTokenOptions({
      capability: dynamic,
      account: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
      rpcUrl: 'https://rpc.example',
    });

    expect(result).toHaveLength(20);
  });

  it('keeps using configured tokens when no dynamic mode is present', async () => {
    vi.mocked(fetchTokenBalance).mockResolvedValue(2_000_000n);

    const result = await loadFeeTokenOptions({
      capability: {
        supported: true,
        tokens: [
          {
            uid: 'usdc',
            symbol: 'USDC',
            address: '0x2222222222222222222222222222222222222222',
            decimals: 6,
            interop: false,
            feeToken: true,
            logoURI: 'https://example.com/usdc.png',
          },
        ],
      },
      account: '0x1111111111111111111111111111111111111111',
      chainId: 84532,
      rpcUrl: 'https://rpc.example',
    });

    expect(handleGetAssetsRequest).not.toHaveBeenCalled();
    expect(result[0]).toEqual(
      expect.objectContaining({ balance: 2_000_000n, logoURI: 'https://example.com/usdc.png' })
    );
  });
});
