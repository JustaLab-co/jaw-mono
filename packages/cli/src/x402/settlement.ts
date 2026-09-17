import { parseAbiItem, decodeEventLog } from 'viem';
import { publicClientFor } from './balance.js';
import { parseBigInt } from './amount.js';
import { errorMessage } from '../lib/errors.js';
import { usdcForNetwork, type UsdcAsset } from './asset-registry.js';
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
 * A real payment runs this inside the payment lock, so the bound is on how long
 * an agent that has been offline for a week can hold it: without one, its first
 * payment back opens a chain read for every unverified row it accumulated.
 *
 * `x402 status` and a dry run reach it too, and neither holds the lock. What
 * they can collide with is a compaction, which notices the file changed under
 * it and drops its rewrite, so the cost is a fold deferred to the next payment.
 */
const RECONCILE_BATCH = 8;

/**
 * How long a row is asked about before it is given up on.
 *
 * An authorization is good for minutes, and a settlement that was ever going to
 * land has landed long before this. What is left after a week is a row the chain
 * cannot answer: a receipt that is mined but carries no transfer between this
 * payer and this recipient, because the facilitator routed it through an
 * intermediary, or a network the client can no longer reach. Those stay
 * answerable for good, hold a slot in every batch, and cost a receipt read on
 * every payment forever.
 *
 * Long enough that a laptop closed over a holiday still reconciles its own rows
 * when it comes back.
 */
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const NONCE_BITMAP_ABI = [
  parseAbiItem('function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)'),
] as const;

const AUTHORIZATION_STATE_ABI = [
  parseAbiItem('function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'),
] as const;

/**
 * Fold every answer the chain has for the unverified rows in `entries`.
 *
 * Takes the entries the caller already read rather than reading again: the pay
 * paths take one snapshot of the ledger per payment and every window is counted
 * against those same rows.
 */
export async function reconcileSettlements(entries: X402LogEntry[]): Promise<X402LogEntry[]> {
  // Half from each end rather than the oldest eight. A row can be answerable
  // and still never answer: a node that will not serve its receipt, a chain the
  // client cannot reach. Taken from one end, those rows hold every slot on every
  // payment, and the rows the live caps are still counting are never reached.
  const answerableRows = entries.filter(answerable);
  const fromOldest = Math.ceil(RECONCILE_BATCH / 2);
  const pending =
    answerableRows.length <= RECONCILE_BATCH
      ? answerableRows
      : [...answerableRows.slice(0, fromOldest), ...answerableRows.slice(-(RECONCILE_BATCH - fromOldest))];
  // Retired without a chain read, because there is no read to make: these are
  // the rows no batch can reach. Not bounded like the batch either, for the same
  // reason.
  const retired = entries
    .filter(unanswerable)
    .map(abandonedIfOld)
    .filter((answer): answer is X402SettlementCorrection => answer !== null);
  if (pending.length === 0 && retired.length === 0) return entries;

  // Together, not one after the other. The reads are independent and this holds
  // the payment lock while they run: eight of them at 200ms each measured 1.6s
  // sequentially, which is the wait this module exists to keep off the payment
  // path in the first place.
  const answered = await Promise.all(
    pending.map(async (entry) => {
      try {
        return (await answerFor(entry)) ?? abandonedIfOld(entry);
      } catch (err) {
        // A row is a line in a file a user can edit, and nothing here may fail
        // the payment waiting on it. The row keeps costing its ceiling.
        process.stderr.write(`[jaw] warning: could not reconcile nonce ${entry.nonce} (${errorMessage(err)})\n`);
        return null;
      }
    })
  );

  const answers = new Map<string, X402SettlementCorrection>();
  for (const answer of [...answered, ...retired]) {
    if (!answer) continue;
    appendX402Correction(answer);
    answers.set(answer.corrects, answer);
  }
  if (answers.size === 0) return entries;

  return entries.map((entry) => {
    const answer = entry.nonce ? answers.get(entry.nonce) : undefined;
    // Every field `readX402Log` folds, so what this hands back and what the next
    // read produces cannot come apart.
    return answer
      ? {
          ...entry,
          settlement: answer.settlement,
          amount: answer.amount ?? entry.amount,
          txHash: answer.txHash ?? entry.txHash,
        }
      : entry;
  });
}

/**
 * Whether the chain can be asked about this row at all.
 *
 * A row that named a transaction can be looked up, and an authorization past its
 * deadline carries a consumption flag: Permit2's bitmap under `upto`, the
 * token's own `authorizationState` under `exact`. What has no question to put is
 * an attempt still inside its deadline, where an unconsumed nonce proves
 * nothing because the settlement can still land.
 *
 * The filter is what keeps those from taking a slot in the batch below. Eight
 * of them, and the oldest-first slice never reached a row that could be
 * answered again, so every later payment kept costing its ceiling until the
 * caps refused it.
 */
function answerable(entry: X402LogEntry): boolean {
  if (entry.settlement !== 'unverified' || !entry.nonce) return false;
  if (entry.txHash) return true;
  return (entry.scheme === 'upto' || entry.scheme === 'exact') && deadlinePassed(entry);
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

/**
 * Whether there is no question to put about this row right now.
 *
 * `answerable` needs a transaction to look up, or a deadline behind us under a
 * scheme whose consumption flag this can read. An attempt whose authorization is
 * still live has neither, and it is answerable minutes later when the deadline
 * passes. A row from before the ledger carried `scheme` never is, and it is
 * those the sweep below exists for: nothing moves them off `unverified` on their
 * own, so they are charged at their ceiling for the life of the session total
 * and, since the fold protects rows an answer could still find by nonce, they
 * pin every later compaction.
 */
function unanswerable(entry: X402LogEntry): boolean {
  return entry.settlement === 'unverified' && Boolean(entry.nonce) && !answerable(entry);
}

/**
 * Stop asking about a row the chain has had long enough to answer.
 *
 * Only the asking stops. The ceiling stands, because nothing here found out
 * what moved, and a row nobody can answer is worth what its signature was worth
 * until something does. What this buys is the two places that filter on
 * `unverified`: the row leaves the reconcile batch, so the rows a live cap is
 * still counting are reached, and compaction may fold it away, which it must
 * never do while an answer could still arrive and find it by nonce.
 */
function abandonedIfOld(entry: X402LogEntry): X402SettlementCorrection | null {
  const written = Date.parse(entry.at);
  if (!Number.isFinite(written) || Date.now() - written < GIVE_UP_AFTER_MS) return null;
  return {
    at: new Date().toISOString(),
    corrects: entry.nonce as string,
    settlement: 'abandoned',
    // No amount: the overlay keeps the row's own, and `spendFigureOf` reads
    // that against the ceiling exactly as it did while this was unverified.
    txHash: entry.txHash,
  };
}

/** What the chain says about one row, or nothing when it has not said yet. */
async function answerFor(entry: X402LogEntry): Promise<X402SettlementCorrection | null> {
  const asset = entry.network ? usdcForNetwork(entry.network) : undefined;
  // A row on a network the registry does not carry has no client to ask and no
  // token to price. Left alone, which keeps it at its ceiling.
  if (!asset || !entry.nonce) return null;

  if (entry.txHash) {
    const moved = await transferredIn(entry, asset);
    if (moved !== null) return correction(entry, 'verified', moved);
  }

  if (!deadlinePassed(entry)) return null;
  if (entry.scheme === 'upto') {
    return (await permit2NonceFree(entry, asset.chainId)) ? correction(entry, 'expired', 0n) : null;
  }
  if (entry.scheme !== 'exact') return null;

  const used = await eip3009NonceUsed(entry, asset);
  if (used === null) return null;
  if (!used) return correction(entry, 'expired', 0n);
  // A consumed `exact` nonce can only have moved what was signed: the value and
  // the recipient are in the signature, and the one other way to spend a nonce is
  // `cancelAuthorization`, which only the authorizer can send and this never
  // sends. So a server that answered 400 while its facilitator settled anyway
  // does not get to leave the row in doubt, and the price is what moved.
  const ceiling = parseBigInt(entry.authorized);
  return ceiling === null ? null : correction(entry, 'verified', ceiling);
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
async function transferredIn(entry: X402LogEntry, asset: UsdcAsset): Promise<bigint | null> {
  let receipt;
  try {
    receipt = await publicClientFor(asset.chainId).getTransactionReceipt({ hash: entry.txHash as `0x${string}` });
  } catch {
    // Not mined yet, or the node did not answer. Both mean "ask again", and
    // neither may cost the payment that is waiting on this.
    return null;
  }
  if (receipt.status !== 'success') return null;

  let moved: bigint | null = null;
  for (const log of receipt.logs) {
    // The registry's address when the row carries none: comparing against
    // `undefined` skipped every log, so a mined transaction that did move funds
    // read as "the chain has not said yet" and the row kept its ceiling.
    if (log.address.toLowerCase() !== (entry.asset ?? asset.address).toLowerCase()) continue;
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
 * Whether the Permit2 nonce an `upto` authorization signed against is still
 * unspent, so its deadline passed without moving anything.
 *
 * The deadline alone proves nothing, since a settlement we failed to find is
 * indistinguishable from one that never happened. An unreadable nonce and a node
 * that will not answer both read as spent, which leaves the row at its ceiling.
 */
async function permit2NonceFree(entry: X402LogEntry, chainId: number): Promise<boolean> {
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
 * Whether the token has consumed this `exact` authorization, or `null` when the
 * question could not be put: the nonce is not the 32 bytes EIP-3009 takes, or
 * the node did not answer.
 *
 * Asks the registry's USDC and not the row's `asset`: the ledger is a file a
 * user can edit, and a hand-written address would send this read to whatever
 * contract it names.
 */
async function eip3009NonceUsed(entry: X402LogEntry, asset: UsdcAsset): Promise<boolean | null> {
  const nonce = entry.nonce as string;
  if (!/^0x[0-9a-f]{64}$/i.test(nonce)) return null;

  try {
    return await publicClientFor(asset.chainId).readContract({
      address: asset.address,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [entry.payer as `0x${string}`, nonce as `0x${string}`],
    });
  } catch {
    return null;
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
