import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { config, SUPPORTED_CHAINS } from '@/connections/config';

export type VerifySignature = (a: {
  chainId: number;
  address: Address;
  message: string;
  signature: Hex;
}) => Promise<boolean>;

/** A client for `chainId`; the configured RPC applies only to the configured chain. */
export function publicClientFor(chainId: number): PublicClient {
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not supported`);
  const { chain: configured, rpcUrl } = config();
  return createPublicClient({ chain, transport: http(chain.id === configured.id ? rpcUrl : undefined) });
}

export const verifyOnChain: VerifySignature = async ({ chainId, address, message, signature }) =>
  publicClientFor(chainId).verifyMessage({ address, message, signature });
