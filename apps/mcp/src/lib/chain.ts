import { getSupportedChains, JAW_RPC_URL } from '@jaw.id/core';
import {
  createPublicClient,
  http,
  withTimeout,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
} from 'viem';
import { config, SUPPORTED_CHAINS } from '@/connections/config';

/** What an owner signs: plain text, or EIP-712 typed data. */
export type SignedPayload =
  | { type: 'message'; message: string }
  | { type: 'typed_data'; typedData: TypedDataDefinition };

/** False when the signature does not verify, malformed bytes included; rejects only when the chain cannot be asked. */
export type VerifySignature = (a: {
  chainId: number;
  address: Address;
  payload: SignedPayload;
  signature: Hex;
}) => Promise<boolean>;

// JAW's RPC proxy, which serves the bundler methods too.
export function rpcUrl(chainId: number) {
  const key = config().paymasterApiKey;
  return `${JAW_RPC_URL}?chainId=${chainId}${key ? `&api-key=${key}` : ''}`;
}

const clients = new Map<number, PublicClient>();

export function publicClientFor(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not supported`);
  const { chain: configured, rpcUrl } = config();
  const client = createPublicClient({ chain, transport: http(chain.id === configured.id ? rpcUrl : undefined) });
  clients.set(chainId, client);
  return client;
}

/** Every chain JAW serves, testnets included. */
export const proxyChains = () => getSupportedChains(true);

/** Whether JAW serves this chain. */
export const isProxyChain = (chainId: number) => proxyChains().some((c) => c.id === chainId);

const proxied = new Map<number, PublicClient>();

/** A read client for any JAW chain, through JAW's RPC proxy. The payment paths keep `publicClientFor`. */
export function proxyClientFor(chainId: number): PublicClient {
  const cached = proxied.get(chainId);
  if (cached) return cached;
  const chain = proxyChains().find((c) => c.id === chainId);
  if (!chain) throw new Error(`chain ${chainId} is not supported`);
  const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) });
  proxied.set(chainId, client);
  return client;
}

const PROBE_MS = 3_000;

export const verifyOnChain: VerifySignature = async ({ chainId, address, payload, signature }) => {
  const client = publicClientFor(chainId);
  const valid = await (payload.type === 'message'
    ? client.verifyMessage({ address, message: payload.message, signature })
    : client.verifyTypedData({ address, signature, ...payload.typedData }));
  // viem answers false when the node cannot be reached too; only a node that answers makes it a bad signature.
  if (!valid) {
    await withTimeout(() => client.getBlockNumber({ cacheTime: 0 }), {
      timeout: PROBE_MS,
      errorInstance: new Error('the node did not answer the block number in time'),
    });
  }
  return valid;
};
