import { encodeFunctionData, erc20Abi } from 'viem';
import { usdcForNetwork, type UsdcAsset } from './asset-registry.js';
import { publicClientFor, usdcBalance, type BalanceReader } from './balance.js';
import { PERMIT2_ADDRESS } from './permit2.js';
import { parseBigInt } from './amount.js';
import { firstOperationCost, gasReserve } from './gas-reserve.js';
import { errorMessage } from '../lib/errors.js';
import type { X402PaymentRequirement } from './types.js';

/**
 * Permission top-up (flow 2b): when the session payer EOA can't cover a
 * payment, refill it from the user's account through the granted on-chain
 * permission, then let the normal EIP-3009 payment run.
 *
 * The transfer executes as the session smart account via
 * `wallet_sendCalls(permissionId)`. `JustaPermissionManager` enforces the
 * per-token, per-period cap on-chain, so the user's keys and wallet are never
 * involved: the agent only ever receives what the permission releases.
 *
 * Gas for that transfer is charged by the ERC-20 paymaster to whoever sends the
 * userOp, which is the permission's spender, and the spender is the payer: a
 * session is one address. So every refill carries `gasReserve` on top of what
 * the payment needs, leaving the fee something to come out of and the next
 * refill something to be charged for. The first one is covered by the grant,
 * which sends the same amount to the session when the permission is approved.
 *
 * The reserve doubles as a float, since payments spend it too. A long run of
 * prices well under it can drain it, and the refill that follows is charged
 * like any other: there is nothing left that would sponsor it instead.
 */

/** The slice of the session auto-mode bridge the funder needs. */
export interface TopUpExecutor {
  request(method: string, params?: unknown): Promise<unknown>;
  /**
   * Approve Permit2 to move `token` on the payer's own behalf, returning the
   * batch id. Deliberately narrow and deliberately separate from `request`: it
   * is the one call the session makes outside its permission, so it takes a
   * token and nothing else, and it cannot be used to send anything but that
   * approval. Optional so an executor that never pays `upto` need not have it.
   */
  approvePermit2?: GrantApproval;
}

/**
 * Grant Permit2 the allowance, returning the batch id. Named because the
 * allowance check hands it back once it has established the session can do it,
 * which keeps the caller from having to assert it a second time.
 */
export type GrantApproval = (token: `0x${string}`) => Promise<string>;

/** Reads an ERC-20 allowance. Injected for tests. */
export type AllowanceReader = (asset: UsdcAsset, owner: `0x${string}`, spender: `0x${string}`) => Promise<bigint>;

const readAllowance: AllowanceReader = (asset, owner, spender) =>
  publicClientFor(asset.chainId).readContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });

export interface TopUpOptions {
  /**
   * The chain the session (and its permission) lives on. When set, a payment
   * on any other chain refuses to top up instead of executing a transfer on
   * the wrong chain — an ERC-20 call to an address with no code there would
   * "succeed" without moving anything.
   */
  sessionChainId?: number;
  /**
   * Refill target in base units. When set, a needed top-up brings the payer
   * balance up to this float (fewer on-chain hops for bursts of payments);
   * when unset, the top-up is exactly the shortfall (minimum idle funds).
   */
  floatTarget?: bigint;
  /**
   * Upper bound on a single top-up (base units) — what is left of the tightest
   * spend cap. The payer must never be pre-funded with more than the session
   * could still spend: that would be idle funds at risk with no benefit,
   * weakening the blast-radius guarantee. What the clamp cuts is the float. A
   * cap with less left than the payment needs is a refusal instead, since the
   * transfer that would fit is one the payment cannot be made out of.
   */
  maxTopUp?: bigint;
  /** Poll interval for the call status, ms. */
  pollMs?: number;
  /** Give up waiting for confirmation after this long, ms. */
  timeoutMs?: number;
  /** Injected for tests. */
  balanceReader?: BalanceReader;
  allowanceReader?: AllowanceReader;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TopUpOutcome {
  ok: boolean;
  /** True when the balance already covered the price and nothing ran. */
  skipped?: boolean;
  /** Base units transferred, when a top-up ran. */
  amount?: string;
  /** wallet_sendCalls batch id, when a top-up ran. */
  batchId?: string;
  /**
   * The payer's Permit2 allowance as this run last saw it. Handed back so the
   * signer does not ask the same contract the same question a second time
   * within the same payment. Absent when nothing read it.
   */
  permit2Allowance?: bigint;
  /**
   * Batch id of the Permit2 approval, when one was granted. Its own field
   * because it is a real userOp charged to the payer's USDC and it can happen
   * with no top-up beside it, so folding it into `batchId` would either erase
   * it or make a top-up look like it ran. It moves no principal, so nothing
   * that totals topped-up base units may read it.
   */
  approvalBatchId?: string;
  /** Human-readable refusal when ok=false. Never throws for policy-shaped failures. */
  reason?: string;
}

interface CallStatus {
  status?: number | string;
}

function isFinalStatus(s: CallStatus | undefined): 'ok' | 'failed' | 'pending' {
  // The bridge resolves to `undefined` when the in-memory store misses and the
  // receipt lookup throws (Account.getCallStatus). This runs after the transfer
  // is already broadcast, so a TypeError here loses the audit row that meters
  // the period cap, and the next ceiling stays permissive.
  if (!s) return 'pending';
  const v = s.status;
  // EIP-5792: 100 = pending, 200 = confirmed, >= 400 = failure.
  if (v === 200 || v === '200' || v === 'CONFIRMED') return 'ok';
  if (v === 100 || v === '100' || v === 'PENDING' || v === undefined) return 'pending';
  return 'failed';
}

/**
 * Ensure the payer EOA can cover `requirement.amount`, topping it up through
 * the on-chain permission when it can't. Designed as the `ensureFunds` hook of
 * `payAndFetch`: runs after the policy approved the requirement and before the
 * payment is signed.
 */
export async function ensurePayerFunds(
  requirement: X402PaymentRequirement,
  payerAddress: `0x${string}`,
  executor: TopUpExecutor,
  opts: TopUpOptions = {}
): Promise<TopUpOutcome> {
  const asset = usdcForNetwork(requirement.network);
  if (!asset) {
    // Unsupported networks are the scheme validator's problem, not the funder's.
    return { ok: true, skipped: true };
  }

  if (requirement.asset && requirement.asset.toLowerCase() !== asset.address.toLowerCase()) {
    // The requirement wants a token we don't know how to fund; let the scheme
    // validation refuse it rather than topping up the wrong asset.
    return { ok: true, skipped: true };
  }

  if (opts.sessionChainId !== undefined && opts.sessionChainId !== asset.chainId) {
    return {
      ok: false,
      reason:
        `session is on chain ${opts.sessionChainId} but the payment needs chain ${asset.chainId}; ` +
        `run \`jaw session setup --chain ${asset.chainId}\` to pay on this network`,
    };
  }

  const price = parseBigInt(requirement.amount);
  if (price === null) {
    return { ok: false, reason: `non-numeric payment amount: ${requirement.amount}` };
  }

  // Whether Permit2 still needs an allowance is read here, before the balance,
  // because the answer changes how much the payer needs. Granting it is a
  // userOp the payer pays for out of its own USDC, so it has to happen AFTER
  // the top-up, not before: the top-up is lazy, a payer that has not paid yet
  // sits at zero, and approving first meant the approval could not be priced
  // and the payment was refused without ever reaching the funding that would
  // have covered it.
  let grantApproval: GrantApproval | null = null;
  let permit2Allowance: bigint | undefined;
  if (requirement.scheme === 'upto') {
    const status = await permit2ApprovalStatus(asset, payerAddress, price, executor, opts);
    if (!status.ok) return { ok: false, reason: status.reason };
    grantApproval = status.grant;
    // Only useful when it already covers the payment. When it does not, the
    // figure below is the one the signer must be told about, and until the
    // approval lands there is nothing worth handing forward.
    permit2Allowance = grantApproval ? undefined : status.allowance;
  }

  const read = opts.balanceReader;
  const balance = read
    ? await read(asset, payerAddress)
    : BigInt((await usdcBalance(requirement.network, payerAddress)).raw);

  // A payer holding exactly the price can pay it and nothing else, so when an
  // approval is still owed the bar is the price plus something to be charged
  // against. The reserve is 0.1 USDC against roughly 0.01 an operation, so one
  // covers the approval with room to spare.
  const needed = grantApproval ? price + gasReserve(asset) : price;

  if (balance >= needed) {
    if (grantApproval) {
      const granted = await grantPermit2Allowance(asset, payerAddress, price, grantApproval, executor, opts);
      // `skipped` says no principal moved, which stays true, but the approval
      // is a userOp the user paid for and it belongs in the trace either way.
      if (!granted.ok) return { ok: false, reason: granted.reason, approvalBatchId: granted.batchId };
      // No principal moved, but the approval is a userOp the payer was charged
      // for, so its balance is not what the branch above checked any more.
      const short = await payerStillShort(
        asset,
        payerAddress,
        price,
        requirement.network,
        balance,
        opts,
        AFTER_APPROVAL
      );
      if (short) return { ok: false, reason: short, approvalBatchId: granted.batchId };
      return { ok: true, skipped: true, approvalBatchId: granted.batchId, permit2Allowance: granted.allowance };
    }
    return { ok: true, skipped: true, permit2Allowance };
  }

  const shortfall = needed - balance;
  const headroom = firstOperationCost(asset);
  // The payer pays the fee for the very transfer that refills it, so a refill
  // clamped to exactly the shortfall lands short by that fee: the payment is
  // then signed for more than the payer holds and fails, with the cap already
  // spent on it. Below one operation over the shortfall there is no amount worth
  // pulling, so refuse here, while nothing has moved. It stays at one operation
  // and not a multiple of it: what the fee actually turns out to be is read back
  // after the refill lands, and a wider bar here would only refuse payments that
  // settle, leaving the tail of every period cap unspendable. Measured against
  // `needed` rather than the price, so an upto payment that still owes Permit2
  // an approval is judged with that operation counted in.
  if (opts.maxTopUp !== undefined && opts.maxTopUp < shortfall + headroom) {
    return {
      ok: false,
      reason:
        `the tightest spend cap has ${opts.maxTopUp} base units left and this payment needs ` +
        `${shortfall + headroom} topped up: ${shortfall} short, plus ${headroom} of headroom for the fee the ` +
        'payer is charged for the refill itself. Wait for the period to reset, or raise the cap.',
    };
  }

  const target = opts.floatTarget !== undefined && opts.floatTarget > needed ? opts.floatTarget : needed;
  // The payer is the account this userOp is sent from, so it is the one the
  // ERC-20 paymaster charges, in postOp and right after this transfer lands.
  // Pulling only what the payment costs leaves nothing for the fee, so the fee
  // comes out of the payment and the payment itself lands short. The reserve
  // rides along and stays behind, so the next refill has something to be
  // charged against.
  let amount = (target - balance > shortfall ? target - balance : shortfall) + gasReserve(asset);
  // Never pre-fund the payer past what the caps still allow. The guard above
  // has already established that what they allow covers the shortfall and a
  // fee, so what this cuts is float and never the payment.
  if (opts.maxTopUp !== undefined && amount > opts.maxTopUp) {
    amount = opts.maxTopUp;
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [payerAddress, amount],
  });

  let batchId: string;
  try {
    // Account.sendCalls resolves to `{ id, chainId }` (EIP-5792 shape); accept
    // a bare string too so the funder doesn't couple to one bridge version.
    const sent = await executor.request('wallet_sendCalls', [{ calls: [{ to: asset.address, data }] }]);
    const id = typeof sent === 'string' ? sent : (sent as { id?: string } | null)?.id;
    if (!id) {
      // Broadcast already happened, so carry the amount even with no id to
      // confirm it by: the caller gates its audit row on having one or the
      // other, and funds that moved have to reach the ledger.
      return {
        ok: false,
        reason: 'top-up submitted but no call id returned; cannot confirm it',
        amount: amount.toString(),
      };
    }
    batchId = id;
  } catch (err) {
    // The permission is the security boundary: a revert here means it said no.
    // The two common causes read very differently to a user, so hint at both:
    // the granted permission must both allow a USDC transfer to the payer
    // (calls whitelist) and have budget left (spend allowance).
    const msg = errorMessage(err);
    return {
      ok: false,
      reason:
        `top-up refused on-chain (${msg}). The session permission must allow a USDC ` +
        `transfer to the payer and still have spend allowance this period; check the grant ` +
        `from \`jaw session setup\` or the remaining cap.`,
    };
  }

  const confirmed = await awaitCall(executor, batchId, opts, {
    subject: 'top-up',
    onChainFailure: 'top-up transaction failed on-chain (spending cap reached, or permission expired/revoked)',
  });
  if (!confirmed.ok) {
    return { ok: false, reason: confirmed.reason, amount: amount.toString(), batchId };
  }

  // Past this line the transfer landed, so the refusal below still carries the
  // trace: the caller writes its audit row from these fields, and money that
  // moved has to reach the ledger whatever happens next.
  let approvalBatchId: string | undefined;
  if (grantApproval) {
    const granted = await grantPermit2Allowance(asset, payerAddress, price, grantApproval, executor, opts);
    approvalBatchId = granted.batchId;
    if (!granted.ok) {
      return { ok: false, reason: granted.reason, amount: amount.toString(), batchId, approvalBatchId };
    }
    permit2Allowance = granted.allowance;
  }

  const short = await payerStillShort(asset, payerAddress, price, requirement.network, balance, opts, AFTER_REFILL);
  if (short) return { ok: false, reason: short, amount: amount.toString(), batchId, approvalBatchId };

  return { ok: true, amount: amount.toString(), batchId, approvalBatchId, permit2Allowance };
}

/**
 * The poll clock the funder waits on, with its defaults in one place. Three
 * loops wait out the same two things, a confirmation and replica lag, and each
 * kept its own copy of the interval.
 */
function pollClock(opts: TopUpOptions) {
  return {
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    pollMs: opts.pollMs ?? 2_000,
  };
}

/**
 * How many times to look for something a confirmed userOp should already have
 * changed, before giving up on the node catching up. The bundler has confirmed
 * it by then, so both loops that use this are waiting out replica lag and not a
 * settlement: a few polls, or it is something else that is wrong.
 */
const LAG_POLL_ATTEMPTS = 3;

/**
 * What the payer was charged for since the balance above it was read, and what
 * an operator should do about a payer left short by it.
 *
 * Two paths reach the same check and only one of them refills: the other sends
 * the Permit2 approval on a payer that already covered the price. Blaming the
 * permission cap there would send an operator to raise a cap no refill drew
 * from, so the subject is passed in rather than assumed.
 */
interface ChargedFor {
  /** Names the userOp the payer was charged for, in the refusal and the warnings. */
  moment: string;
  /** Why the payer can be short of it, and what to do. */
  cause: string;
}

const AFTER_REFILL: ChargedFor = {
  moment: 'the refill',
  cause:
    'the fee it was charged for the refill came to more than the headroom left for it. Retry once the cap allows ' +
    'a larger one.',
};

const AFTER_APPROVAL: ChargedFor = {
  moment: 'the Permit2 approval',
  cause:
    'the gas for that approval came to more than the reserve the payer held over the price. Retry the payment: ' +
    'the next attempt refills the payer through the permission.',
};

/**
 * Whether the payer can actually pay, read after the userOps it was charged for.
 *
 * The bar before the refill is a prediction: it guesses the fee the payer is
 * about to be charged for the transfer that refills it. This is the measurement,
 * and it needs no constant at all. Whatever the fee turned out to be, at any gas
 * price on any chain, the balance says so.
 *
 * Refusing here still costs the caps what already moved, so the refusal carries
 * the trace for the audit row. It costs a retry; signing a payment the payer
 * cannot cover costs the whole ceiling, because a failed attempt reserves it.
 *
 * That makes a false refusal expensive, and the confirmation does not rule one
 * out: the bundler confirmed the userOp, this reads `balanceOf` through a
 * different provider, and a replica a block behind still answers with the
 * pre-refill figure. So `before` is passed in. A balance that has not moved at
 * all is a lag signature and not a fee, since the refill credited the payer and
 * the fee then debited it. Only a balance observed to have moved is judged; one
 * that never moves polls, and then goes on with a warning rather than refusing a
 * payment whose funds have already landed.
 *
 * A read that fails proceeds for the same reason. The transfer has landed and
 * drawn the cap either way, so refusing on an unreachable node buys a certain
 * non-payment where going on still has a chance of settling.
 */
async function payerStillShort(
  asset: UsdcAsset,
  payerAddress: `0x${string}`,
  price: bigint,
  network: string,
  before: bigint,
  opts: TopUpOptions,
  charged: ChargedFor
): Promise<string | null> {
  const { sleep, pollMs } = pollClock(opts);

  for (let attempt = 0; attempt < LAG_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(pollMs);
    let balance: bigint;
    try {
      const read = opts.balanceReader;
      balance = read ? await read(asset, payerAddress) : BigInt((await usdcBalance(network, payerAddress)).raw);
    } catch (err) {
      // Said out loud rather than swallowed: the payment goes on, and the operator
      // needs to know the one check that would have caught a short payer never ran.
      console.warn(
        `[jaw] Could not re-read the payer balance after ${charged.moment} (${errorMessage(err)}); paying anyway.`
      );
      return null;
    }
    if (balance >= price) return null;
    if (balance !== before) {
      return `the payer holds ${balance} base units after ${charged.moment} and this payment needs ${price}: ${charged.cause}`;
    }
  }

  console.warn(
    `[jaw] The payer balance still reads ${before} base units after ${charged.moment}, unchanged from before it, ` +
      'so the node read here has not caught up; paying anyway.'
  );
  return null;
}

/**
 * Whether Permit2 still needs an allowance from this payer, and whether this
 * session is in a position to grant one. Split from the granting below because
 * the answer is needed before the balance branch: the approval is a userOp the
 * payer pays for, so it decides how much the top-up has to pull.
 *
 * `upto` settles through Permit2 rather than by EIP-3009, and Permit2 pulls the
 * token through the canonical ERC-20 allowance. Without it the proxy cannot
 * execute what the payer signed, so the payment fails at settlement and, by the
 * ledger's rule, reserves its whole ceiling against the cap for nothing.
 *
 * Granted lazily and not at `jaw session setup`, because most sessions never
 * touch an `upto` endpoint and a mandatory extra userOp would tax the common
 * path for a feature it will not use. Granted for the maximum, because the
 * alternative is an approval userOp before every payment, and the blast radius
 * either way is the payer's float, which the top-up already keeps small.
 *
 * It is the one call the session sends outside its permission, and it has to
 * be: `JustaPermissionManager` validates every call's selector against the
 * grant and the x402 grant permits `transfer` only, so an approval routed
 * through the permission reverts. Sent by the payer on its own balance it never
 * reaches the manager, whose approval revocation and Permit2 lockdown both act
 * on the granting account and only within their own execution.
 */
async function permit2ApprovalStatus(
  asset: UsdcAsset,
  payerAddress: `0x${string}`,
  needed: bigint,
  executor: TopUpExecutor,
  opts: TopUpOptions
): Promise<{ ok: true; grant: GrantApproval | null; allowance: bigint } | { ok: false; reason: string }> {
  const read = opts.allowanceReader ?? readAllowance;
  let allowance: bigint;
  try {
    allowance = await read(asset, payerAddress, PERMIT2_ADDRESS);
  } catch (err) {
    return { ok: false, reason: `could not read the payer's Permit2 allowance: ${errorMessage(err)}` };
  }
  if (allowance >= needed) return { ok: true, grant: null, allowance };

  // Bound to the executor rather than read off it bare. The production executor
  // is a SessionBridge, where `approvePermit2` is a prototype method whose first
  // statement reads `this`, so a detached reference throws once it is finally
  // called. It would throw in the worst place there is: the approval is the last
  // step of the funder, after the top-up has already pulled the user's USDC
  // through the permission, so the funds move and the payment refuses anyway,
  // and every retry repeats the top-up.
  const grant = executor.approvePermit2?.bind(executor);

  // Refused here rather than after the top-up: a session that cannot grant the
  // allowance cannot pay this challenge at all, and moving funds first would
  // spend the permission's budget on a payment that was never going to happen.
  if (!grant) {
    return {
      ok: false,
      reason:
        `the payer has not approved Permit2 to move ${asset.address}, and this session cannot grant it. ` +
        'Approve Permit2 once on this chain to pay upto challenges.',
    };
  }

  // Handed back rather than re-read later, so the type carries what the check
  // established: past here, granting is something this session can do.
  return { ok: true, grant, allowance };
}

/** Send the approval and wait for it. Only called once the payer can pay for it. */
async function grantPermit2Allowance(
  asset: UsdcAsset,
  payerAddress: `0x${string}`,
  needed: bigint,
  grant: GrantApproval,
  executor: TopUpExecutor,
  opts: TopUpOptions
): Promise<{ ok: boolean; reason?: string; batchId?: string; allowance?: bigint }> {
  let batchId: string;
  try {
    batchId = await grant(asset.address);
  } catch (err) {
    return { ok: false, reason: `Permit2 approval refused: ${errorMessage(err)}` };
  }

  const confirmed = await awaitCall(executor, batchId, opts, {
    subject: 'Permit2 approval',
    onChainFailure: `Permit2 approval failed on-chain (batch ${batchId})`,
  });
  // The id rides on the refusal too: the approval was broadcast either way, and
  // a confirmation timeout is exactly when someone needs it to go looking.
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason, batchId };

  // Confirmed by the bundler is not the same as visible to the node the payer
  // reads from, and the payer re-reads this allowance immediately afterwards,
  // right before signing. A node a block behind would refuse a payment whose
  // approval had already landed, after the user paid for both it and the
  // top-up. Same client the payer will use, so seeing it here is what makes
  // that read safe.
  const visible = await allowanceVisible(asset, payerAddress, needed, opts);
  if (visible === null) {
    return {
      ok: false,
      batchId,
      reason:
        `the Permit2 approval confirmed (batch ${batchId}) but the allowance is not visible yet on this ` +
        'chain; retry the payment in a moment, the approval does not need to be sent again.',
    };
  }

  return { ok: true, batchId, allowance: visible };
}

async function allowanceVisible(
  asset: UsdcAsset,
  payerAddress: `0x${string}`,
  needed: bigint,
  opts: TopUpOptions
): Promise<bigint | null> {
  const read = opts.allowanceReader ?? readAllowance;
  const { sleep, pollMs } = pollClock(opts);

  for (let attempt = 0; attempt < LAG_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(pollMs);
    try {
      const seen = await read(asset, payerAddress, PERMIT2_ADDRESS);
      if (seen >= needed) return seen;
    } catch {
      // A read that failed is a read that did not see it. The refusal this
      // ends in names the batch, so nothing is lost by trying again first.
    }
  }
  return null;
}

/**
 * Poll a submitted batch to a final state.
 *
 * Shared by the top-up and the Permit2 approval because both are userOps the
 * payment cannot proceed without, and both have the same two ways of going
 * wrong. The subject is threaded through so the reason still names which one
 * failed, and the on-chain failure text is passed in because the causes differ:
 * a top-up is refused by the permission, an approval is not sent through one.
 */
async function awaitCall(
  executor: TopUpExecutor,
  batchId: string,
  opts: TopUpOptions,
  labels: { subject: string; onChainFailure: string }
): Promise<{ ok: boolean; reason?: string }> {
  const now = opts.now ?? Date.now;
  const { sleep, pollMs } = pollClock(opts);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const deadline = now() + timeoutMs;

  for (;;) {
    let status: CallStatus;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race the status read against the remaining deadline: a hung bundler
      // socket would otherwise never let the loop reach the deadline check
      // below, wedging the payment (and, through the mutex, all payments).
      // The loser of a race is never cancelled, so the timer needs its own
      // handle and a clearTimeout: left armed it holds the event loop open,
      // and the CLI would sit for the rest of the timeout with `Paid.` already
      // on screen (oclif does not force-exit on the success path).
      const remaining = Math.max(deadline - now(), 0);
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`status check timed out after ${timeoutMs}ms`)), remaining);
      });
      status = (await Promise.race([executor.request('wallet_getCallsStatus', batchId), expired])) as CallStatus;
    } catch (err) {
      return { ok: false, reason: `${labels.subject} status check failed: ${errorMessage(err)}` };
    } finally {
      clearTimeout(timer);
    }

    const final = isFinalStatus(status);
    if (final === 'ok') return { ok: true };
    if (final === 'failed') return { ok: false, reason: labels.onChainFailure };
    if (now() >= deadline) {
      return { ok: false, reason: `${labels.subject} not confirmed after ${timeoutMs}ms` };
    }
    await sleep(pollMs);
  }
}
