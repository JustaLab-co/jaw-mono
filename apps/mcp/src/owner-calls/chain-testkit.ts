import type { ChainClients } from '@jaw.id/agent';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  numberToHex,
  zeroAddress,
  type Hex,
} from 'viem';
import { entryPoint08Abi, entryPoint08Address } from 'viem/account-abstraction';

export interface FakeEvent {
  userOpHash: Hex;
  block: bigint;
  txHash: Hex;
  success: boolean;
}

/** A node that speaks JSON-RPC: block numbers, block timestamps and UserOperationEvent logs. */
export function fakeChain({
  head,
  events = [],
  blockSeconds = 2,
  down = false,
}: {
  head: bigint;
  events?: FakeEvent[];
  blockSeconds?: number;
  down?: boolean;
}) {
  const ranges: { from: bigint; to: bigint }[] = [];
  const logOf = (e: FakeEvent) => ({
    address: entryPoint08Address,
    topics: encodeEventTopics({
      abi: entryPoint08Abi,
      eventName: 'UserOperationEvent',
      args: { userOpHash: e.userOpHash, sender: zeroAddress, paymaster: zeroAddress },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [1n, e.success, 21_000n, 21_000n]
    ),
    blockNumber: numberToHex(e.block),
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: e.txHash,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  });
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    if (down) throw new Error('the node is down');
    const args = (params ?? []) as unknown[];
    if (method === 'eth_blockNumber') return numberToHex(head);
    if (method === 'eth_getBlockByNumber') {
      const number = BigInt(args[0] as string);
      return {
        number: numberToHex(number),
        hash: `0x${'22'.repeat(32)}`,
        timestamp: numberToHex(number * BigInt(blockSeconds)),
        transactions: [],
      };
    }
    if (method === 'eth_getLogs') {
      const [{ fromBlock, toBlock, topics }] = args as [{ fromBlock: string; toBlock: string; topics: string[] }];
      ranges.push({ from: BigInt(fromBlock), to: BigInt(toBlock) });
      return events
        .filter((e) => e.userOpHash === topics[1] && e.block >= BigInt(fromBlock) && e.block <= BigInt(toBlock))
        .map(logOf);
    }
    throw new Error(`the fake node does not answer ${method}`);
  };
  const client = createPublicClient({ transport: custom({ request }) });
  const clients: ChainClients = { publicClient: () => client };
  return { clients, ranges };
}
