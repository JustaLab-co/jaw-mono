import { usdcForNetwork, within, type ChainClients, type UsdcAsset } from '@jaw.id/agent';
import { decodeEventLog, isAddressEqual, parseAbi, type Address, type Hex, type TransactionReceipt } from 'viem';

const EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** What a signed attempt needs to be checked against the chain. */
export interface Attempt {
  payer: Address;
  nonce: Hex;
  scheme: string;
  network: string;
  payTo: Address;
  /** Base units the signature authorized: what an `exact` payment moved. */
  authorized: bigint;
}

export interface Settled {
  txHash: Hex;
  blockTime: Date;
  amount: bigint;
}

/**
 * What a mined transaction proves about this attempt. Under `exact` the token
 * logged this payer's nonce as used, and the signature fixed the value. Under
 * `upto` the transfer from payer to payTo is what moved, never above the ceiling.
 */
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

/**
 * Settles an attempt from the transaction the seller named, or answers nothing
 * when the chain does not prove it within `timeoutMs`. Never throws.
 */
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
const BLOCK_SECONDS = 2;

export type ChainAnswer = ({ kind: 'settled' } & Settled) | { kind: 'expired' } | { kind: 'open' };

async function nonceUsed(attempt: Attempt, token: UsdcAsset, clients: ChainClients): Promise<boolean> {
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

/** The transaction that used an `exact` nonce, searched from the blocks around when it was signed. */
async function usedIn(
  attempt: Attempt,
  token: UsdcAsset,
  signedAt: Date,
  clients: ChainClients
): Promise<Hex | undefined> {
  const client = clients.publicClient(token.chainId);
  const latest = await client.getBlockNumber();
  const behind = BigInt(Math.ceil((Date.now() - signedAt.getTime()) / 1000 / BLOCK_SECONDS) + 300);
  const logs = await client.getLogs({
    address: token.address,
    event: EVENTS[0],
    args: { authorizer: attempt.payer, nonce: attempt.nonce },
    fromBlock: latest > behind ? latest - behind : 0n,
    toBlock: latest,
  });
  return logs[0]?.transactionHash ?? undefined;
}

/**
 * What the chain says about a signed attempt: settled with its transaction,
 * expired with its nonce unused past the deadline, or open. Read failures are
 * open, so the next run asks again. Never throws.
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
      return attempt.deadline.getTime() < Date.now() ? { kind: 'expired' } : { kind: 'open' };
    }
    if (attempt.scheme !== 'exact') return { kind: 'open' };
    const txHash = await usedIn(attempt, token, attempt.signedAt, clients);
    const found = txHash && (await confirmByReceipt(attempt, txHash, clients, timeoutMs));
    return found ? { kind: 'settled', ...found } : { kind: 'open' };
  };
  return within(read(), timeoutMs).catch((): ChainAnswer => ({ kind: 'open' }));
}
