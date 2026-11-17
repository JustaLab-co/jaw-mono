import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { fetchTokenQuotes, handleGetAssetsRequest, type TokenQuote } from '@jaw.id/core';
import { fetchTokenBalance } from './tokenBalance';
import { loadFeeTokenOptions } from './feeTokens';

vi.mock('@jaw.id/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jaw.id/core')>()),
  handleGetAssetsRequest: vi.fn(),
  fetchTokenQuotes: vi.fn(),
}));

vi.mock('./tokenBalance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tokenBalance')>()),
  fetchTokenBalance: vi.fn(),
}));

const dynamic = { supported: true, mode: 'dynamic' as const };
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const PAYMASTER = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';

const erc20 = (address: string, symbol: string, balance: bigint, decimals = 18) => ({
  address,
  balance: `0x${balance.toString(16)}`,
  metadata: { decimals, name: symbol, symbol },
  type: 'erc20' as const,
});
const ether = (balance: bigint) => ({
  address: null,
  balance: `0x${balance.toString(16)}`,
  metadata: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  type: 'native' as const,
});

/**
 * Answers quotes like the paymaster: `rates` maps a token to its exchange rate
 * (token units per 1e18 wei), a token missing from it is left out, and a request
 * over 20 tokens is refused.
 */
function quoteLikePaymaster(rates: Record<string, bigint>) {
  vi.mocked(fetchTokenQuotes).mockImplementation(async (_url, _chainId, tokens) => {
    if (tokens.length > 20) throw new Error('jaw_getTokenQuotes error: too many tokens');
    return tokens.flatMap((token): TokenQuote[] => {
      const rate = rates[token.toLowerCase()];
      return rate ? [{ tokenAddress: token, exchangeRate: rate, postOpGas: 1n, paymasterAddress: PAYMASTER }] : [];
    });
  });
}

const load = () =>
  loadFeeTokenOptions({ capability: dynamic, account: ACCOUNT, chainId: 8453, rpcUrl: 'https://rpc.example' });
const symbols = (options: { symbol: string }[]) => options.map((o) => o.symbol);

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
    quoteLikePaymaster({ '0x2222222222222222222222222222222222222222': 4_000_000_000n });

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
      '0x2105': Array.from({ length: 25 }, (_, index) =>
        erc20(`0x${(index + 1).toString(16).padStart(40, '0')}`, `T${index}`, 1n)
      ),
    });
    quoteLikePaymaster(
      Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`0x${(index + 1).toString(16).padStart(40, '0')}`, 10n ** 18n])
      )
    );

    expect(await load()).toHaveLength(20);
  });

  // PR 653 review: aBasUSDC has no price, and its address sorts before USDC's.
  it('leaves out a token the paymaster cannot price', async () => {
    const A_BAS_USDC = '0x4e65fe4dba92790696d040ac24aa414708f5c0ab';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({
      '0x2105': [erc20(A_BAS_USDC, 'aBasUSDC', 10_000_000n, 6), erc20(USDC, 'USDC', 5_000_000n, 6)],
    });
    quoteLikePaymaster({ [USDC]: 4_000_000_000n });

    expect(symbols(await load())).toEqual(['USDC']);
  });

  it('offers the native coin first, then the priced tokens by value, highest first', async () => {
    const SPAM = '0x0000000000000000000000000000000000000001';
    const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const WETH = '0x4200000000000000000000000000000000000006';
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({
      '0x2105': [
        ether(10n ** 15n),
        erc20(SPAM, 'SPAM', 10n ** 30n),
        erc20(WETH, 'WETH', 5n * 10n ** 15n), // $20 at $4000
        erc20(DAI, 'DAI', 5n * 10n ** 18n), // $5
        erc20(USDC, 'USDC', 50_000_000n, 6), // $50
      ],
    });
    quoteLikePaymaster({ [DAI]: 4000n * 10n ** 18n, [USDC]: 4_000_000_000n, [WETH]: 10n ** 18n });

    expect(symbols(await load())).toEqual(['ETH', 'USDC', 'WETH', 'DAI']);
  });

  it('quotes more than 20 held tokens in batches and keeps the 20 worth most', async () => {
    const address = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`;
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({
      // Held amounts grow with the address, so the most valuable sort last.
      '0x2105': Array.from({ length: 35 }, (_, i) => erc20(address(i), `T${i}`, BigInt(i + 1) * 10n ** 18n)),
    });
    quoteLikePaymaster(Object.fromEntries(Array.from({ length: 35 }, (_, i) => [address(i), 10n ** 18n])));

    const result = await load();

    expect(vi.mocked(fetchTokenQuotes).mock.calls.map(([, , tokens]) => tokens.length)).toEqual([20, 15]);
    expect(symbols(result)).toEqual(Array.from({ length: 20 }, (_, i) => `T${34 - i}`));
  });

  it('offers only the native coin when quoting fails', async () => {
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({
      '0x2105': [ether(10n ** 15n), erc20('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 5_000_000n, 6)],
    });
    vi.mocked(fetchTokenQuotes).mockRejectedValue(new Error('jaw_getTokenQuotes failed with 503'));

    expect(symbols(await load())).toEqual(['ETH']);
  });

  it('leaves out a native coin with no balance', async () => {
    vi.mocked(handleGetAssetsRequest).mockResolvedValue({ '0x2105': [ether(0n)] });

    expect(await load()).toEqual([]);
    expect(fetchTokenQuotes).not.toHaveBeenCalled();
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
