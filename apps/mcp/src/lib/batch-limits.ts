import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { entryPoint08Address } from 'viem/account-abstraction';
import { rpcUrl } from '@/lib/chain';

/** Calls one batch may carry, so the owner can still read what they approve. */
export const MAX_CALLS = 100;
// JAW's proxy refuses a request body over 100 KB. The calldata goes in it as hex, twice its size, beside the deploy
// data, the signature and the paymaster's data.
export const MAX_BATCH_BYTES = 40_000;
// The bundler pads a userOp before it sizes the transaction (call gas x1.5 + 100k; verification gas counted three
// times, plus 200k, all x1.1) and bundles up to four userOps without adding them up. On a chain that caps a
// transaction at 2^24 gas (EIP-7825), 5M of call gas leaves room for three ordinary userOps beside this one.
const MAX_BATCH_GAS = 5_000_000n;
// Around the calls, in transaction gas: the bundle's base 25k; this userOp's deploy, passkey check and paymaster,
// padded, ~2.03M; three ordinary userOps beside it, ~1.64M each.
const AROUND_CALLS = 6_975_000n;
const CHECK_MS = 5_000;

// Every JAW account is an EIP-1167 clone of one implementation, the factory's immutable, at this address on every chain.
const ACCOUNT_CODE: Hex =
  '0x363d3d373d3d3d363d73bb4f7d5418cd8dadb61bb95561179e517572cbcd5af43d82803e903d91602b57fd5bf3';

const accountAbi = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);

export interface BatchCall {
  to: Address;
  value: bigint;
  data: Hex;
}

const batchData = (calls: BatchCall[]) =>
  encodeFunctionData({
    abi: accountAbi,
    functionName: 'executeBatch',
    args: [calls.map((c) => ({ target: c.to, value: c.value, data: c.data }))],
  });

/**
 * The calldata the wallet sends for these calls, in bytes: executeBatch's selector, the array's offset and length,
 * then per call its offset, target, value, data offset and length, and the data padded to 32 bytes.
 */
export const batchBytes = (calls: { data: Hex }[]) =>
  calls.reduce((sum, c) => sum + 160 + Math.ceil((c.data.length - 2) / 64) * 32, 68);

/** The gas a batch's calls may need on a chain whose blocks hold `blockGasLimit`. */
export function gasBudget(blockGasLimit: bigint): bigint {
  // Call gas counts x1.65 once padded, and 10% is kept for what changes before the owner signs: x6/11 in all.
  const fit = blockGasLimit > AROUND_CALLS ? ((blockGasLimit - AROUND_CALLS) * 6n) / 11n : 0n;
  return fit < MAX_BATCH_GAS ? fit : MAX_BATCH_GAS;
}

/** One request each, no retries: the check answers quickly or leaves the decision to the wallet. */
export const gasClientFor = (chainId: number): PublicClient =>
  createPublicClient({ transport: http(rpcUrl(chainId), { retryCount: 0, timeout: CHECK_MS }) });

/**
 * The gas the batch needs and the chain's budget, when it needs more; undefined when it fits. Throws when the chain
 * cannot tell, a batch that reverts included.
 */
export async function overBudget(
  client: PublicClient,
  account: Address,
  calls: BatchCall[]
): Promise<{ gas: bigint; budget: bigint } | undefined> {
  const [code, block] = await Promise.all([client.getCode({ address: account }), client.getBlock()]);
  // Without it the budget would be 0 and every batch refused.
  if (typeof block.gasLimit !== 'bigint') throw new Error('the block has no gas limit');
  // An account the wallet has not deployed yet runs as the clone it will deploy; one with code, as it is.
  const gas = await client.estimateGas({
    account: entryPoint08Address,
    to: account,
    data: batchData(calls),
    stateOverride: code ? undefined : [{ address: account, code: ACCOUNT_CODE }],
  });
  const budget = gasBudget(block.gasLimit);
  return gas > budget ? { gas, budget } : undefined;
}
