import type { ChainClients } from '@jaw.id/agent';
import { getAbiItem, type Hex } from 'viem';
import { entryPoint08Abi, entryPoint08Address } from 'viem/account-abstraction';
import { z } from 'zod';
import { rpcUrl } from '@/lib/chain';
import type { OwnerCallRow } from './store';

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

// The bundler answers for a recent user operation only; past that, the chain is the record.
const LOG_FALLBACK_AFTER_MS = 10 * 60_000;
// eth_getLogs ranges are capped by public RPCs, down to 200 blocks on sepolia.base.org.
const CHUNK_BLOCKS = 200n;
// 10,000 blocks forward of the start, about 5.5 hours at 2 second blocks.
const MAX_CHUNKS = 50;
// The head is read after the wallet answered, so the operation can sit a few blocks behind it.
const HEAD_MARGIN_BLOCKS = 100n;
const BLOCK_TIME_SAMPLE = 1_000n;

// JAW accounts submit through EntryPoint v0.8, the one core defaults to.
const userOperationEvent = getAbiItem({ abi: entryPoint08Abi, name: 'UserOperationEvent' });

/**
 * Looks for the operation's event from `fromBlock` forward, at most MAX_CHUNKS
 * ranges of CHUNK_BLOCKS per call. Null when none is found; throws when the node cannot be read.
 */
export async function findUserOpEvent(
  clients: ChainClients,
  chainId: number,
  userOpHash: Hex,
  fromBlock: bigint
): Promise<Receipt | null> {
  const client = clients.publicClient(chainId);
  const head = await client.getBlockNumber();
  let from = fromBlock;
  for (let i = 0; i < MAX_CHUNKS && from <= head; i++) {
    const to = from + CHUNK_BLOCKS - 1n < head ? from + CHUNK_BLOCKS - 1n : head;
    const [found] = await client.getLogs({
      address: entryPoint08Address,
      event: userOperationEvent,
      args: { userOpHash },
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    if (found) return { success: found.args.success, txHash: found.transactionHash };
    from = to + 1n;
  }
  return null;
}

/** Where to start looking: the recorded head, or for rows without one, the age of the row in blocks plus a margin. */
async function startBlock(row: OwnerCallRow, clients: ChainClients, now: number): Promise<bigint> {
  if (row.sentBlock !== null) return row.sentBlock > HEAD_MARGIN_BLOCKS ? row.sentBlock - HEAD_MARGIN_BLOCKS : 0n;
  const client = clients.publicClient(row.chainId);
  const head = await client.getBlockNumber();
  const sample = head < BLOCK_TIME_SAMPLE ? head : BLOCK_TIME_SAMPLE;
  if (sample === 0n) return 0n;
  const [newest, older] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: head - sample }),
  ]);
  const msPerBlock = (Number(newest.timestamp - older.timestamp) * 1000) / Number(sample);
  const ageBlocks = BigInt(Math.ceil((now - row.updatedAt.getTime()) / msPerBlock));
  // 20% on top of the age absorbs block times that drifted since the call was sent.
  const back = ageBlocks + ageBlocks / 5n + HEAD_MARGIN_BLOCKS;
  return head > back ? head - back : 0n;
}

/** The bundler's receipt, or for a call it has gone quiet on, the event on chain. */
export async function receiptOf(
  row: OwnerCallRow,
  bundler: ReadReceipt,
  clients: ChainClients,
  now: number
): Promise<Receipt | null> {
  const userOpHash = row.callsId as Hex;
  const mined = await bundler(row.chainId, userOpHash);
  if (mined || now - row.updatedAt.getTime() < LOG_FALLBACK_AFTER_MS) return mined;
  return findUserOpEvent(clients, row.chainId, userOpHash, await startBlock(row, clients, now));
}
