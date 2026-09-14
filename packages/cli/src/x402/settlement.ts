import { parseAbiItem, decodeEventLog } from 'viem';
import { publicClientFor } from './balance.js';
import { parseBigInt } from './amount.js';
import { errorMessage } from '../lib/errors.js';
import { usdcForNetwork } from './asset-registry.js';
import { PERMIT2_ADDRESS } from './permit2.js';
import {
  appendX402Correction,
  type SettlementState,
  type X402LogEntry,
  type X402SettlementCorrection,
} from './ledger.js';

/**
 * Check what a receipt claimed against what the chain shows, one payment later.
 *
 * Under `upto` the server picks the settled figure and the receipt is the only
 * place it exists, so `settledAmountOf` accepts it on a receipt that claims
 * success and carries something shaped like a transaction hash. Shaped like one
 * is all that is checked, which leaves a server free to report one base unit
 * against a thousand-unit ceiling, never consume the Permit2 nonce, and hold a
 * live authorization for the difference until the deadline.
 *
 * The check does not run where the receipt arrives. Not because it could not:
 * measured against a facilitator answering the instant it broadcast, the
 * receipt was queryable 194ms later. Because doing it there makes every payment
 * wait on a node inside the payment lock, which is the margin two issues of
 * this cycle just spent PRs defending, and the honest payment would be paying
 * that wait to catch the dishonest one.
 *
 * So the row is written unverified and costs its ceiling, and the next payment
 * settles the question before it reads the caps. A slow node changes no number
 * and fails no payment: the row simply stays unverified and is tried again.
 */

/**
 * Rows attempted per run, oldest first.
 *
 * This runs inside the payment lock, so the bound is on how long an agent that
 * has been offline for a week can hold it: without one, its first payment back
 * opens a chain read for every unverified row it accumulated.
 */
const RECONCILE_BATCH = 8;

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const NONCE_BITMAP_ABI = [
  parseAbiItem('function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)'),
] as const;

/**
 * Fold every answer the chain has for the unverified rows in `entries`.
 *
 * Takes the entries the caller already read rather than reading again: the pay
 * paths take one snapshot of the ledger per payment and every window is counted
 * against those same rows.
 */
export async function reconcileSettlements(entries: X402LogEntry[]): Promise<X402LogEntry[]> {
  const pending = entries.filter(answerable).slice(0, RECONCILE_BATCH);
  if (pending.length === 0) return entries;

  // Together, not one after the other. The reads are independent and this holds
  // the payment lock while they run: eight of them at 200ms each measured 1.6s
  // sequentially, which is the wait this module exists to keep off the payment
  // path in the first place.
  const answered = await Promise.all(
    pending.map(async (entry) => {
      try {
        return await answerFor(entry);
      } catch (err) {
        // A row is a line in a file a user can edit, and nothing here may fail
        // the payment waiting on it. The row keeps costing its ceiling.
        process.stderr.write(`[jaw] warning: could not reconcile nonce ${entry.nonce} (${errorMessage(err)})\n`);
        return null;
      }
    })
  );

  const answers = new Map<string, X402SettlementCorrection>();
  for (const answer of answered) {
    if (!answer) continue;
    appendX402Correction(answer);
    answers.set(answer.corrects, answer);
  }
  if (answers.size === 0) return entries;

  return entries.map((entry) => {
    const answer = entry.nonce ? answers.get(entry.nonce) : undefined;
    return answer ? { ...entry, settlement: answer.settlement, amount: answer.amount ?? entry.amount } : entry;
  });
}

/**
 * Whether the chain can be asked about this row at all.
 *
 * A row that named a transaction can be looked up, and an `upto` authorization
 * past its deadline has a Permit2 bitmap to read. Anything else has no question
 * to put: a `failed` row carries no hash, since the pay paths record
 * `outcome.payment?.txHash` and a failure has no payment, and only `upto` signs
 * against Permit2.
 *
 * The filter is what keeps those from taking a slot in the batch below. Eight
 * of them, and the oldest-first slice never reached a row that could be
 * answered again, so every later payment kept costing its ceiling until the
 * caps refused it.
 */
function answerable(entry: X402LogEntry): boolean {
  if (entry.settlement !== 'unverified' || !entry.nonce) return false;
  return Boolean(entry.txHash) || (entry.scheme === 'upto' && deadlinePassed(entry));
}

/**
 * Whether the authorization's deadline is behind us.
 *
 * An unreadable one is not. The ledger is a file a user can edit, and
 * `Number('abc')` is `NaN`, which loses every comparison: read as "past" it
 * would send a live authorization down the expiry path and cost it zero.
 */
function deadlinePassed(entry: X402LogEntry): boolean {
  const seconds = Number(entry.deadline);
  return Number.isFinite(seconds) && seconds * 1000 <= Date.now();
}

/** What the chain says about one row, or nothing when it has not said yet. */
async function answerFor(entry: X402LogEntry): Promise<X402SettlementCorrection | null> {
  const asset = entry.network ? usdcForNetwork(entry.network) : undefined;
  // A row on a network the registry does not carry has no client to ask and no
  // token to price. Left alone, which keeps it at its ceiling.
  if (!asset || !entry.nonce) return null;

  if (entry.txHash) {
    const moved = await transferredIn(entry, asset.chainId);
    if (moved !== null) return correction(entry, 'verified', moved);
  }

  return (await authorizationDied(entry, asset.chainId)) ? correction(entry, 'expired', 0n) : null;
}

/**
 * What actually left the payer in the transaction the receipt named, or nothing
 * when the chain cannot say yet.
 *
 * Reads the `Transfer` log rather than decoding the calldata. The transaction
 * belongs to the facilitator and its shape is theirs to change, while the
 * transfer has to be there for the payment to have happened at all, and the
 * three fields that identify it are on every ledger row already.
 */
async function transferredIn(entry: X402LogEntry, chainId: number): Promise<bigint | null> {
  let receipt;
  try {
    receipt = await publicClientFor(chainId).getTransactionReceipt({ hash: entry.txHash as `0x${string}` });
  } catch {
    // Not mined yet, or the node did not answer. Both mean "ask again", and
    // neither may cost the payment that is waiting on this.
    return null;
  }
  if (receipt.status !== 'success') return null;

  let moved: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== entry.asset?.toLowerCase()) continue;
    let event;
    try {
      event = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    // A facilitator may settle several payments in one transaction, so the pair
    // is what picks ours out of the batch.
    const ours =
      event.args.from.toLowerCase() === entry.payer.toLowerCase() &&
      event.args.to.toLowerCase() === entry.payTo?.toLowerCase();
    if (ours) moved = (moved ?? 0n) + event.args.value;
  }
  // Nothing of ours in it is no evidence, not evidence of zero. A mined
  // transaction anyone can copy off an explorer would otherwise verify a row at
  // zero, which is a cheaper lie than the fabricated hash this exists to catch.
  return moved;
}

/**
 * Whether the authorization expired without ever being spent.
 *
 * Two things have to be true: the deadline is behind us, and the nonce was
 * never consumed. The deadline alone proves nothing, since a settlement we
 * failed to find is indistinguishable from one that never happened.
 *
 * Only `upto` signs against Permit2, so only `upto` has a bitmap to read. An
 * `exact` row is left where it is, and costs the same as it did before this
 * function existed.
 */
async function authorizationDied(entry: X402LogEntry, chainId: number): Promise<boolean> {
  if (entry.scheme !== 'upto' || !deadlinePassed(entry)) return false;

  let nonce: bigint;
  try {
    nonce = BigInt(entry.nonce as string);
  } catch {
    return false;
  }

  try {
    const word = await publicClientFor(chainId).readContract({
      address: PERMIT2_ADDRESS,
      abi: NONCE_BITMAP_ABI,
      functionName: 'nonceBitmap',
      args: [entry.payer as `0x${string}`, nonce >> 8n],
    });
    return ((word >> (nonce & 0xffn)) & 1n) === 0n;
  } catch {
    return false;
  }
}

/**
 * Never above what the signature authorized.
 *
 * A facilitator settling two of our payments to the same recipient in one
 * transaction shows both transfers to both rows, and the pair of addresses
 * cannot tell them apart. The ceiling can: it is the most either row could have
 * cost, whatever the transaction totals. Landing high rather than low is the
 * direction the rest of this errs in on purpose.
 */
function correction(entry: X402LogEntry, settlement: SettlementState, amount: bigint): X402SettlementCorrection {
  const ceiling = parseBigInt(entry.authorized);
  const figure = ceiling !== null && amount > ceiling ? ceiling : amount;
  return {
    at: new Date().toISOString(),
    corrects: entry.nonce as string,
    settlement,
    amount: figure.toString(),
    txHash: entry.txHash,
  };
}
