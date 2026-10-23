import { getAddress, zeroAddress, type Address } from 'viem';
import { BRIDGE_CHAINS, type BridgeToken } from './contracts';

export type BridgeProvider = 'across' | 'relay';

export type BridgeCall = { chainId: number; to: string; data?: string; value?: string };

export type Unreadable = { kind: 'unreadable'; provider: BridgeProvider };

export type Token =
  | { address: Address; known: true; symbol: string; decimals: number }
  | { address: Address; known: false };
export type TokenAmount = { chainId: number; amount: bigint; token: Token };

/** What arrives: at least an amount, or a token whose amount a swap on the destination sets. */
export type Received = { kind: 'minimum'; amount: TokenAmount } | { kind: 'swap'; chainId: number; token: Token };

export function pinnedToken(chainId: number, address: string): BridgeToken | undefined {
  return BRIDGE_CHAINS[chainId]?.tokens[getAddress(address)];
}

export function tokenOf(chainId: number, address: Address): Token {
  if (address === zeroAddress) {
    return { address, known: true, symbol: BRIDGE_CHAINS[chainId].nativeSymbol, decimals: 18 };
  }
  const pinned = pinnedToken(chainId, address);
  return pinned ? { address, known: true, ...pinned } : { address, known: false };
}

export const tokenAmount = (chainId: number, address: Address, amount: bigint): TokenAmount => ({
  chainId,
  amount,
  token: tokenOf(chainId, address),
});
