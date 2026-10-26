import { getAddress, zeroAddress, type Address } from 'viem';
import type { BridgeToken } from './contracts';
import type { BridgeContracts } from './table';

export type BridgeProvider = 'across' | 'relay';

export type BridgeCall = { chainId: number; to: string; data?: string; value?: string };

export type Unreadable = { kind: 'unreadable'; provider: BridgeProvider };

export type Token =
  | { address: Address; known: true; symbol: string; decimals: number }
  | { address: Address; known: false };
export type TokenAmount = { chainId: number; amount: bigint; token: Token };

/** What arrives: at least an amount, or a token whose amount a swap on the destination sets. */
export type Received = { kind: 'minimum'; amount: TokenAmount } | { kind: 'swap'; chainId: number; token: Token };

export function pinnedToken(contracts: BridgeContracts, chainId: number, address: string): BridgeToken | undefined {
  return contracts.chain(chainId)?.tokens[getAddress(address)];
}

export function tokenOf(contracts: BridgeContracts, chainId: number, address: Address): Token {
  if (address === zeroAddress) {
    return { address, known: true, symbol: contracts.chain(chainId)!.nativeSymbol, decimals: 18 };
  }
  const pinned = pinnedToken(contracts, chainId, address);
  return pinned ? { address, known: true, ...pinned } : { address, known: false };
}

export const tokenAmount = (
  contracts: BridgeContracts,
  chainId: number,
  address: Address,
  amount: bigint
): TokenAmount => ({
  chainId,
  amount,
  token: tokenOf(contracts, chainId, address),
});

export function callValue(value: string | undefined): bigint | undefined {
  try {
    return BigInt(value || 0);
  } catch {
    return undefined;
  }
}
