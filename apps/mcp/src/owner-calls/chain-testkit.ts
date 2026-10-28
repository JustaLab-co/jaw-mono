import type { ChainClients } from '@jaw.id/agent';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  numberToHex,
  zeroAddress,
  type Hex,
  type PublicClient,
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

/**
 * A node for the batch gas check: the account's code ('0x' when it is not deployed), the latest block's gas limit
 * (null leaves it out), and what eth_estimateGas answers, an error included. Records every request and the chain each
 * client was asked for.
 */
export function gasNode({
  code = '0x',
  gasLimit = 60_000_000n,
  gas = 100_000n,
  down = false,
}: {
  code?: Hex;
  gasLimit?: bigint | null;
  gas?: bigint | Error;
  down?: boolean;
} = {}) {
  const asked: { method: string; params: unknown[] }[] = [];
  const chains: number[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    asked.push({ method, params: (params ?? []) as unknown[] });
    if (down) throw new Error('the node is down');
    if (method === 'eth_getCode') return code;
    if (method === 'eth_getBlockByNumber') {
      return {
        number: '0x64',
        hash: `0x${'22'.repeat(32)}`,
        timestamp: '0x64',
        gasLimit: gasLimit === null ? undefined : numberToHex(gasLimit),
        transactions: [],
      };
    }
    if (method === 'eth_estimateGas') {
      if (gas instanceof Error) throw gas;
      return numberToHex(gas);
    }
    throw new Error(`the fake node does not answer ${method}`);
  };
  const client: PublicClient = createPublicClient({ transport: custom({ request }, { retryCount: 0 }) });
  const clientFor = (chainId: number): PublicClient => {
    chains.push(chainId);
    return client;
  };
  return { clientFor, asked, chains };
}
