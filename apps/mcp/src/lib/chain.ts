import type { SignedPayload } from '@jaw.id/agent';
import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { config, SUPPORTED_CHAINS } from '@/connections/config';

export type VerifySignature = (a: {
  chainId: number;
  address: Address;
  payload: SignedPayload;
  signature: Hex;
}) => Promise<boolean>;

/** A client for `chainId`; the configured RPC applies only to the configured chain. */
export function publicClientFor(chainId: number): PublicClient {
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not supported`);
  const { chain: configured, rpcUrl } = config();
  return createPublicClient({ chain, transport: http(chain.id === configured.id ? rpcUrl : undefined) });
}

export const verifyOnChain: VerifySignature = async ({ chainId, address, payload, signature }) => {
  const client = publicClientFor(chainId);
  return payload.type === 'message'
    ? client.verifyMessage({ address, message: payload.message, signature })
    : client.verifyTypedData({ address, signature, ...payload.typedData });
};
