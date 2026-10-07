import { createPublicClient, http, type Address, type Hex } from 'viem';
import { config } from '@/connections/config';

export type VerifySignature = (a: { address: Address; message: string; signature: Hex }) => Promise<boolean>;

export const verifyOnChain: VerifySignature = ({ address, message, signature }) => {
  const { chain, rpcUrl } = config();
  return createPublicClient({ chain, transport: http(rpcUrl) }).verifyMessage({ address, message, signature });
};
