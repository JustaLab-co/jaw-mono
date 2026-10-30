import { getAddress, zeroAddress, type Address } from 'viem';
import type { BridgeToken } from './contracts';
import { readKey, type BridgeContracts } from './table';

export type BridgeProvider = 'across' | 'relay';

export type BridgeCall = { chainId: number; to: string; data?: string; value?: string };

export type Unreadable = { kind: 'unreadable'; provider: BridgeProvider; outsideTable?: true };

/**
 * Pinned in the table (`known`), read from the token itself (`unverified`, its own word and not
 * to be trusted), or not read at all.
 */
export type Token =
  | { address: Address; known: true; symbol: string; decimals: number }
  | { address: Address; known: false; unverified: true; symbol: string; decimals: number }
  | { address: Address; known: false; unverified?: undefined };
export type TokenRef = { chainId: number; address: Address };
export type TokenAmount = { chainId: number; amount: bigint; token: Token };

/** What arrives: at least this amount. */
export type Received = { kind: 'minimum'; amount: TokenAmount };

export function pinnedToken(contracts: BridgeContracts, chainId: number, address: string): BridgeToken | undefined {
  return contracts.chain(chainId)?.tokens[getAddress(address)];
}

export function tokenOf(contracts: BridgeContracts, chainId: number, address: Address): Token {
  if (address === zeroAddress) {
    return { address, known: true, symbol: contracts.chain(chainId)!.nativeSymbol, decimals: 18 };
  }
  const pinned = pinnedToken(contracts, chainId, address);
  if (pinned) return { address, known: true, ...pinned };
  const read = contracts.reads.get(readKey(chainId, address));
  return read ? { address, known: false, unverified: true, ...read } : { address, known: false };
}

/** The ERC-20s in these amounts that are neither pinned nor read yet. */
export const unreadRefs = (amounts: (TokenAmount | undefined)[]): TokenRef[] =>
  amounts.flatMap((a) =>
    a && !a.token.known && !a.token.unverified ? [{ chainId: a.chainId, address: a.token.address }] : []
  );

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
