import type { PublicClient } from 'viem';

/** Read-only chain access, one client per chain id. */
export interface ChainClients {
  publicClient(chainId: number): PublicClient;
}
