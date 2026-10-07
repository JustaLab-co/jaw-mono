import { usdcForNetwork, within, type ChainClients, type UsdcAsset } from '@jaw.id/agent';
import { decodeEventLog, isAddressEqual, parseAbi, type Address, type Hex, type TransactionReceipt } from 'viem';

const EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export interface Attempt {
  payer: Address;
  nonce: Hex;
  scheme: string;
  network: string;
  payTo: Address;
  authorized: bigint;
}

export interface Settled {
  /** Absent when the chain proves the nonce was used but no node returned the transaction. */
  txHash?: Hex;
  blockTime?: Date;
  amount: bigint;
}

function movedIn(receipt: TransactionReceipt, attempt: Attempt, token: Address): bigint | undefined {
  let moved: bigint | undefined;
  for (const entry of receipt.logs) {
    if (!isAddressEqual(entry.address, token)) continue;
    let event;
    try {
      event = decodeEventLog({ abi: EVENTS, data: entry.data, topics: entry.topics });
    } catch {
      continue;
    }
    if (
      attempt.scheme === 'exact' &&
      event.eventName === 'AuthorizationUsed' &&
      isAddressEqual(event.args.authorizer, attempt.payer) &&
      event.args.nonce.toLowerCase() === attempt.nonce.toLowerCase()
    ) {
      return attempt.authorized;
    }
    if (
      attempt.scheme === 'upto' &&
      event.eventName === 'Transfer' &&
      isAddressEqual(event.args.from, attempt.payer) &&
      isAddressEqual(event.args.to, attempt.payTo)
    ) {
      moved = (moved ?? 0n) + event.args.value;
    }
  }
  return moved === undefined || moved <= attempt.authorized ? moved : attempt.authorized;
}

export async function confirmByReceipt(
  attempt: Attempt,
  txHash: Hex,
  clients: ChainClients,
  timeoutMs: number
): Promise<Settled | undefined> {
  const token = usdcForNetwork(attempt.network);
  if (!token) return undefined;
  const read = async () => {
    const client = clients.publicClient(token.chainId);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs, pollingInterval: 500 });
    if (receipt.status !== 'success') return undefined;
    const amount = movedIn(receipt, attempt, token.address);
    if (amount === undefined) return undefined;
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return { txHash, blockTime: new Date(Number(block.timestamp) * 1000), amount };
  };
  return within(read(), timeoutMs).catch(() => undefined);
}

const NONCE_STATE = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)',
]);
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// A node a few blocks behind still reports a nonce unused: past this margin the answer is final.
const EXPIRY_MARGIN_MS = 5 * 60_000;
const SEARCH_MARGIN_BLOCKS = 150n;

export type ChainAnswer = ({ kind: 'settled' } & Settled) | { kind: 'expired' } | { kind: 'open' };

export async function nonceUsed(
  attempt: Pick<Attempt, 'payer' | 'nonce' | 'scheme'>,
  token: UsdcAsset,
  clients: ChainClients
): Promise<boolean> {
  const client = clients.publicClient(token.chainId);
  if (attempt.scheme === 'exact') {
    return client.readContract({
      address: token.address,
      abi: NONCE_STATE,
      functionName: 'authorizationState',
      args: [attempt.payer, attempt.nonce],
    });
  }
  const nonce = BigInt(attempt.nonce);
  const word = await client.readContract({
    address: PERMIT2,
    abi: NONCE_STATE,
    functionName: 'nonceBitmap',
    args: [attempt.payer, nonce >> 8n],
  });
  return ((word >> (nonce & 0xffn)) & 1n) === 1n;
}

/** The transaction that used an `exact` nonce: it lies between the signature and its deadline. */
async function usedIn(
  attempt: Attempt & { deadline: Date; signedAt: Date },
  token: UsdcAsset,
  clients: ChainClients
): Promise<Hex | undefined> {
  const client = clients.publicClient(token.chainId);
  const latest = await client.getBlock();
  const blockMs = BigInt(client.chain?.blockTime ?? 2_000);
  const at = (time: Date) => latest.number - (latest.timestamp * 1000n - BigInt(time.getTime())) / blockMs;
  const from = at(attempt.signedAt) - SEARCH_MARGIN_BLOCKS;
  const to = at(attempt.deadline) + SEARCH_MARGIN_BLOCKS;
  const logs = await client.getLogs({
    address: token.address,
    event: EVENTS[0],
    args: { authorizer: attempt.payer, nonce: attempt.nonce },
    fromBlock: from > 0n ? from : 0n,
    toBlock: to < latest.number ? to : latest.number,
  });
  return logs[0]?.transactionHash ?? undefined;
}

/**
 * What the chain says about a signed attempt: settled, expired with its nonce
 * unused well past the deadline, or open. A used nonce settles at the signed
 * ceiling when no transaction can be found. Read failures are open, so the
 * next run asks again. Never throws.
 */
export async function chainAnswer(
  attempt: Attempt & { txHash?: Hex; deadline: Date; signedAt: Date },
  clients: ChainClients,
  timeoutMs: number
): Promise<ChainAnswer> {
  const token = usdcForNetwork(attempt.network);
  if (!token) return { kind: 'open' };
  const named = attempt.txHash && (await confirmByReceipt(attempt, attempt.txHash, clients, timeoutMs));
  if (named) return { kind: 'settled', ...named };
  const read = async (): Promise<ChainAnswer> => {
    if (!(await nonceUsed(attempt, token, clients))) {
      return attempt.deadline.getTime() + EXPIRY_MARGIN_MS < Date.now() ? { kind: 'expired' } : { kind: 'open' };
    }
    const txHash =
      attempt.scheme === 'exact' ? await usedIn(attempt, token, clients).catch(() => undefined) : undefined;
    const found = txHash && (await confirmByReceipt(attempt, txHash, clients, timeoutMs));
    return found ? { kind: 'settled', ...found } : { kind: 'settled', txHash, amount: attempt.authorized };
  };
  return within(read(), timeoutMs).catch((): ChainAnswer => ({ kind: 'open' }));
}
