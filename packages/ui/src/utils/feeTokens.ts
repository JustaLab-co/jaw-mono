import {
  fetchTokenQuotes,
  handleGetAssetsRequest,
  jawPaymasterUrl,
  type Asset,
  type FeeTokenCapability,
  type TokenQuote,
} from '@jaw.id/core';
import { formatUnits, zeroAddress, type Address } from 'viem';
import type { FeeTokenOption } from '../components/FeeTokenSelector';
import { fetchTokenBalance, isNativeToken } from './tokenBalance';

/** How many ERC-20s the "Pay with" list offers on the dynamic path. */
const MAX_DYNAMIC_ERC20_TOKENS = 20;

/** The paymaster quotes at most this many tokens per request. */
const MAX_TOKENS_PER_QUOTE = 20;

/**
 * ERC-20 contracts that are a chain's own native coin under another address,
 * by chain id. Paying the fee "in" one goes through the ERC-20 paymaster: the
 * same balance as the native option, plus an unlimited approval and the
 * paymaster's markup. So it is never offered as an ERC-20 fee token; its
 * balance is offered as the native coin instead, since `wallet_getAssets` can
 * report the coin only under this address (Celo does) and dropping it would
 * leave the owner with nothing to pay with.
 *
 * Kept here, not in `isNativeToken`: a spend permission on one of these is an
 * ERC-20 permission on chain, and must keep reading as one.
 */
const NATIVE_COIN_ERC20S: Record<number, string> = {
  137: '0x0000000000000000000000000000000000001010', // Polygon: POL (MRC20)
  42220: '0x471ece3750da237f93b8e339c536989b8978a438', // Celo: CELO (GoldToken)
};

const isNativeCoinErc20 = (chainId: number, address: string): boolean =>
  NATIVE_COIN_ERC20S[chainId] === address.toLowerCase();

type LoadFeeTokenOptionsParams = {
  capability: FeeTokenCapability;
  account: string;
  chainId: number;
  rpcUrl: string;
  apiKey?: string;
  showTestnets?: boolean;
};

const option = (
  token: { uid: string; symbol: string; address: string; decimals: number; logoURI?: string },
  balance: bigint,
  isSelectable = balance > 0n
): FeeTokenOption => {
  const native = isNativeToken(token.address);
  return {
    ...token,
    balance,
    balanceFormatted: formatUnits(balance, token.decimals),
    isNative: native,
    isSelectable,
  };
};

async function loadStaticOptions({
  capability,
  account,
  chainId,
  rpcUrl,
}: LoadFeeTokenOptionsParams): Promise<FeeTokenOption[]> {
  const tokens = (capability.tokens ?? []).filter((token) => !isNativeCoinErc20(chainId, token.address));
  return Promise.all(
    tokens.map(async (token) => {
      try {
        const balance = await fetchTokenBalance(token.address, account, rpcUrl, chainId);
        const native = isNativeToken(token.address);
        return option(token, balance, native ? balance > 0n : Number(formatUnits(balance, token.decimals)) >= 0.5);
      } catch (error) {
        console.warn(`Failed to fetch balance for ${token.symbol}:`, error);
        return option(token, 0n);
      }
    })
  );
}

/**
 * Quotes every token, in parallel batches the paymaster accepts. A token with no
 * quote is one the paymaster cannot price, so it cannot pay the fee. A batch that
 * fails leaves its tokens unquoted, so a quote outage leaves only the native coin.
 */
async function quoteAll(
  chainId: number,
  apiKey: string | undefined,
  tokens: Address[]
): Promise<Map<string, TokenQuote>> {
  const url = jawPaymasterUrl(chainId, apiKey);
  const batches: Address[][] = [];
  for (let i = 0; i < tokens.length; i += MAX_TOKENS_PER_QUOTE) {
    batches.push(tokens.slice(i, i + MAX_TOKENS_PER_QUOTE));
  }
  const answers = await Promise.all(
    batches.map((batch) =>
      fetchTokenQuotes(url, chainId, batch).catch((error) => {
        console.warn('Failed to quote fee tokens:', error);
        return [] as TokenQuote[];
      })
    )
  );
  const quotes = new Map<string, TokenQuote>();
  for (const quote of answers.flat()) {
    if (quote.tokenAddress && quote.exchangeRate > 0n) quotes.set(quote.tokenAddress.toLowerCase(), quote);
  }
  return quotes;
}

/**
 * The native coin when held, then the ERC-20s held that the paymaster can price,
 * most valuable first. `wallet_getAssets` lists ERC-20s by address, so capping
 * before ranking could drop the token the owner would pay with.
 *
 * The native coin is the native row, or failing that the coin's own ERC-20 row
 * read as native: both are the one balance, so it is offered once, never summed.
 */
async function dynamicAssets(assets: Asset[], chainId: number, apiKey?: string): Promise<Asset[]> {
  const positive = (asset: Asset) => BigInt(asset.balance) > 0n;
  const isAlias = (asset: Asset) =>
    asset.type === 'erc20' && !!asset.address && isNativeCoinErc20(chainId, asset.address);

  const nativeRow = assets.find((asset) => asset.type === 'native' && positive(asset));
  const aliasRow = assets.find((asset) => isAlias(asset) && positive(asset));
  const nativeCoin = nativeRow ?? (aliasRow && { ...aliasRow, type: 'native' as const, address: null });
  const native = nativeCoin ? [nativeCoin] : [];

  const held = assets.filter((asset) => asset.type === 'erc20' && asset.address && !isAlias(asset) && positive(asset));
  if (held.length === 0) return native;

  const quotes = await quoteAll(
    chainId,
    apiKey,
    held.map((asset) => asset.address as Address)
  );

  // Ranked by the holding in native wei. The paymaster's markup is the same for
  // every token, so it does not change the order.
  const ranked = held
    .flatMap((asset) => {
      const quote = quotes.get((asset.address as string).toLowerCase());
      return quote ? [{ asset, value: (BigInt(asset.balance) * 10n ** 18n) / quote.exchangeRate }] : [];
    })
    .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1))
    .slice(0, MAX_DYNAMIC_ERC20_TOKENS)
    .map(({ asset }) => asset);

  return [...native, ...ranked];
}

/** Resolve static fee-token config or dynamically discover the account's held assets. */
export async function loadFeeTokenOptions(params: LoadFeeTokenOptionsParams): Promise<FeeTokenOption[]> {
  if (!params.capability.supported) return [];
  if (params.capability.mode !== 'dynamic') return loadStaticOptions(params);

  const chainIdHex = `0x${params.chainId.toString(16)}` as `0x${string}`;
  const response = (await handleGetAssetsRequest(
    {
      method: 'wallet_getAssets',
      params: [
        {
          account: params.account,
          chainFilter: [chainIdHex],
          assetTypeFilter: ['native', 'erc20'],
        },
      ],
    },
    params.apiKey,
    params.showTestnets ?? false
  )) as Record<string, Asset[]>;

  const assets = await dynamicAssets(response?.[chainIdHex] ?? [], params.chainId, params.apiKey);
  return assets.flatMap((asset) => {
    if (!asset.metadata) return [];
    const address = asset.type === 'native' ? zeroAddress : asset.address;
    if (!address) return [];
    return [
      option(
        {
          uid: `${params.chainId}:${address.toLowerCase()}`,
          symbol: asset.metadata.symbol,
          address,
          decimals: asset.metadata.decimals,
        },
        BigInt(asset.balance)
      ),
    ];
  });
}
