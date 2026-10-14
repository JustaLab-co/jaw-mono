import { z } from 'zod';
import { rpcUrl } from '@/lib/chain';

const RPC_TIMEOUT_MS = 10_000;

export type Receipt = { success: boolean; txHash: string };
export type ReadReceipt = (chainId: number, callsId: string) => Promise<Receipt | null>;

const answer = z.union([
  z.object({ result: z.null() }),
  z.object({
    result: z.object({
      success: z.boolean(),
      receipt: z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
    }),
  }),
]);

/** Null while the bundler has no receipt; throws when the RPC cannot be read. */
export const readReceipt: ReadReceipt = async (chainId, callsId) => {
  const res = await fetch(rpcUrl(chainId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getUserOperationReceipt', params: [callsId] }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bundler answered ${res.status}`);
  const { result } = answer.parse(await res.json());
  return result && { success: result.success, txHash: result.receipt.transactionHash };
};
