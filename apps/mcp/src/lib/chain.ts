import type { SignedPayload } from '@jaw.id/agent';
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

/** False when the signature does not verify, malformed bytes included; rejects only when the chain cannot be asked. */
export type VerifySignature = (a: {
  chainId: number;
  address: Address;
  payload: Extract<SignedPayload, { type: 'message' | 'typed_data' }>;
  signature: Hex;
}) => Promise<boolean>;

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

const PROBE_MS = 3_000;

export const verifyOnChain: VerifySignature = async ({ chainId, address, payload, signature }) => {
  const client = publicClientFor(chainId);
  const valid = await (payload.type === 'message'
    ? client.verifyMessage({ address, message: payload.message, signature })
    : client.verifyTypedData({ address, signature, ...(payload.typedData as TypedDataDefinition) }));
  // viem answers false when the node cannot be reached too; only a node that answers makes it a bad signature.
  if (!valid) {
    await withTimeout(() => client.getBlockNumber({ cacheTime: 0 }), {
      timeout: PROBE_MS,
      errorInstance: new Error('the node did not answer the block number in time'),
    });
  }
  return valid;
};
