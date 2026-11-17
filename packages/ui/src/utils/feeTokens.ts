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
  return Promise.all(
    (capability.tokens ?? []).map(async (token) => {
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
 */
async function dynamicAssets(assets: Asset[], chainId: number, apiKey?: string): Promise<Asset[]> {
  const native = assets.filter((asset) => asset.type === 'native' && BigInt(asset.balance) > 0n).slice(0, 1);
  const held = assets.filter((asset) => asset.type === 'erc20' && asset.address && BigInt(asset.balance) > 0n);
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
