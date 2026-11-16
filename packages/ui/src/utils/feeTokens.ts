import { handleGetAssetsRequest, type Asset, type FeeTokenCapability } from '@jaw.id/core';
import { formatUnits, zeroAddress } from 'viem';
import type { FeeTokenOption } from '../components/FeeTokenSelector';
import { fetchTokenBalance, isNativeToken } from './tokenBalance';

const MAX_DYNAMIC_ERC20_TOKENS = 20;

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

function dynamicAssets(assets: Asset[]): Asset[] {
  const native = assets.filter((asset) => asset.type === 'native').slice(0, 1);
  const erc20 = assets
    .filter((asset) => asset.type === 'erc20' && asset.address && BigInt(asset.balance) > 0n)
    .slice(0, MAX_DYNAMIC_ERC20_TOKENS);
  return [...native, ...erc20];
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

  return dynamicAssets(response?.[chainIdHex] ?? []).flatMap((asset) => {
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
