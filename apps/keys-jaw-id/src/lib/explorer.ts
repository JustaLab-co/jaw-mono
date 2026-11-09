import { getSupportedChains } from '@jaw.id/core';

/** Explorer page of a transaction, or nothing when the chain has no explorer. */
export function txUrl(chainId: number, hash: string): string | undefined {
  const base = getSupportedChains(true).find((c) => c.id === chainId)?.blockExplorers?.default.url;
  return base && `${base.replace(/\/$/, '')}/tx/${hash}`;
}
