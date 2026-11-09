import type { Hex } from 'viem';

/** The latest wallet_sendCalls this page answered, and how far it got. */
export type Send =
  | { phase: 'submitted' | 'stalled'; id: string; chainId: number }
  | { phase: 'confirmed'; id: string; chainId: number; txHash: Hex }
  | { phase: 'failed'; id: string; chainId: number; txHash?: Hex };

/** The send a successful wallet_sendCalls answer started, or nothing when the answer is not one. */
export function sendFromAnswer(data: unknown): Send | undefined {
  const { id, chainId } = (data ?? {}) as { id?: unknown; chainId?: unknown };
  const chain = typeof chainId === 'string' ? Number(chainId) : chainId;
  if (typeof id !== 'string' || typeof chain !== 'number' || !Number.isInteger(chain)) return;
  return { phase: 'submitted', id, chainId: chain };
}

/** EIP-5792 codes: 100 pending, 200 confirmed, 400 never included, 500 reverted with a receipt. */
export function sendFromStatus(send: Send, status: unknown): Send {
  const { status: code, receipts } = (status ?? {}) as {
    status?: number;
    receipts?: { transactionHash?: Hex }[];
  };
  const { id, chainId } = send;
  const txHash = receipts?.[0]?.transactionHash;
  if (code === 200 && txHash) return { phase: 'confirmed', id, chainId, txHash };
  if (code === 400 || code === 500) return { phase: 'failed', id, chainId, ...(txHash && { txHash }) };
  return send;
}
