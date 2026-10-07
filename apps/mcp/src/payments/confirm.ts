import { usdcForNetwork, within, type ChainClients } from '@jaw.id/agent';
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
