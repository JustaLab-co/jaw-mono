import { usdcForNetwork, within, X402_UPTO_PROXY_ADDRESS, type ChainClients, type UsdcAsset } from '@jaw.id/agent';
import {
  decodeEventLog,
  decodeFunctionData,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
  type Transaction,
  type TransactionReceipt,
} from 'viem';

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
  /** When the authorization was signed: where the search for an `exact` settlement starts. */
  signedAt: Date;
}

const UPTO_SETTLE = parseAbi([
  'struct TokenPermissions { address token; uint256 amount; }',
  'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
  'struct Witness { address to; address facilitator; uint256 validAfter; }',
  'struct EIP2612Permit { uint256 value; uint256 deadline; bytes32 r; bytes32 s; uint8 v; }',
  'function settle(PermitTransferFrom permit, uint256 amount, address owner, Witness witness, bytes signature)',
  'function settleWithPermit(EIP2612Permit permit2612, PermitTransferFrom permit, uint256 amount, address owner, Witness witness, bytes signature)',
]);

/**
 * What an upto settlement moved under this authorization. Only a successful
 * call to the x402 proxy spends a Permit2 nonce the payer signed, so the
 * transaction must be that call, for this owner, nonce, token and recipient.
 */
function settledByProxy(tx: Pick<Transaction, 'to' | 'input'>, attempt: Attempt, token: Address): bigint | undefined {
  if (!tx.to || !isAddressEqual(tx.to, X402_UPTO_PROXY_ADDRESS)) return undefined;
  let call;
  try {
    call = decodeFunctionData({ abi: UPTO_SETTLE, data: tx.input });
  } catch {
    return undefined;
  }
  const [permit, amount, owner, witness] =
    call.functionName === 'settle' ? call.args : [call.args[1], call.args[2], call.args[3], call.args[4]];
  const ours =
    isAddressEqual(owner, attempt.payer) &&
    permit.nonce === BigInt(attempt.nonce) &&
    isAddressEqual(permit.permitted.token, token) &&
    isAddressEqual(witness.to, attempt.payTo) &&
    amount <= attempt.authorized;
  return ours ? amount : undefined;
}

export interface Settled {
  /** Absent when the chain proves the nonce was used but no node returned the transaction. */
  txHash?: Hex;
  blockTime?: Date;
  amount: bigint;
}

/** USDC the payer sent in this receipt, only to `to` when given, capped at the authorized amount. */
function paidBy(receipt: TransactionReceipt, attempt: Attempt, token: Address, to?: Address): bigint | undefined {
  let moved: bigint | undefined;
  for (const entry of receipt.logs) {
    if (!isAddressEqual(entry.address, token)) continue;
    let event;
    try {
      event = decodeEventLog({ abi: EVENTS, data: entry.data, topics: entry.topics });
    } catch {
      continue;
    }
    if (event.eventName !== 'Transfer' || !isAddressEqual(event.args.from, attempt.payer)) continue;
    if (to && !isAddressEqual(event.args.to, to)) continue;
    moved = (moved ?? 0n) + event.args.value;
  }
  return moved === undefined || moved <= attempt.authorized ? moved : attempt.authorized;
}

function movedIn(receipt: TransactionReceipt, attempt: Attempt, token: Address): bigint | undefined {
  if (attempt.scheme === 'upto') return paidBy(receipt, attempt, token, attempt.payTo);
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
  }
  return undefined;
}

const PROXY_EVENTS = parseAbi(['event Settled()', 'event SettledWithPermit()']);

/**
 * What an upto settlement moved when a bundler, not the facilitator, called the
 * proxy. The proxy's events name no owner, so the payer's nonce must flip in
 * this block and this transaction must hold the block's only proxy settle.
 * Payer transfers to anyone count; the cap keeps extra ones at the ceiling.
 */
async function settledInBundle(
  receipt: TransactionReceipt,
  attempt: Attempt,
  token: UsdcAsset,
  clients: ChainClients
): Promise<Settled | undefined> {
  const client = clients.publicClient(token.chainId);
  const settles = await client.getLogs({
    address: X402_UPTO_PROXY_ADDRESS,
    events: PROXY_EVENTS,
    blockHash: receipt.blockHash,
  });
  if (settles.length !== 1 || !sameHash(settles[0].transactionHash, receipt.transactionHash)) return undefined;
  const [before, after] = await Promise.all([
    nonceUsed(attempt, token, clients, receipt.blockNumber - 1n),
    nonceUsed(attempt, token, clients, receipt.blockNumber),
  ]);
  if (before || !after) return undefined;
  const amount = paidBy(receipt, attempt, token.address);
  if (amount === undefined) return undefined;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  // A reorg after the reads above swaps the block at this height.
  if (!sameHash(block.hash, receipt.blockHash)) return undefined;
  return { txHash: receipt.transactionHash, blockTime: new Date(Number(block.timestamp) * 1000), amount };
}

const sameHash = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

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
    const bundled = attempt.scheme === 'upto' && (!receipt.to || !isAddressEqual(receipt.to, X402_UPTO_PROXY_ADDRESS));
    if (bundled) return settledInBundle(receipt, attempt, token, clients);
    const amount = movedIn(receipt, attempt, token.address);
    if (amount === undefined) return undefined;
    if (attempt.scheme === 'upto') {
      const settled = settledByProxy(await client.getTransaction({ hash: txHash }), attempt, token.address);
      if (settled !== amount) return undefined;
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const blockTime = new Date(Number(block.timestamp) * 1000);
    return { txHash, blockTime, amount };
  };
  return within(read(), timeoutMs).catch(() => undefined);
}

const NONCE_STATE = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)',
]);
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// A node a few blocks behind still reports a nonce unused: past this margin the answer is final.
export const EXPIRY_MARGIN_MS = 5 * 60_000;
const SEARCH_MARGIN_BLOCKS = 150n;

export type ChainAnswer = ({ kind: 'settled' } & Settled) | { kind: 'expired' } | { kind: 'open' };

export async function nonceUsed(
  attempt: Pick<Attempt, 'payer' | 'nonce' | 'scheme'>,
  token: UsdcAsset,
  clients: ChainClients,
  blockNumber?: bigint
): Promise<boolean> {
  const client = clients.publicClient(token.chainId);
  if (attempt.scheme === 'exact') {
    return client.readContract({
      address: token.address,
      abi: NONCE_STATE,
      functionName: 'authorizationState',
      args: [attempt.payer, attempt.nonce],
      blockNumber,
    });
  }
  const nonce = BigInt(attempt.nonce);
  const word = await client.readContract({
    address: PERMIT2,
    abi: NONCE_STATE,
    functionName: 'nonceBitmap',
    args: [attempt.payer, nonce >> 8n],
    blockNumber,
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
  attempt: Attempt & { txHash?: Hex; deadline: Date },
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
