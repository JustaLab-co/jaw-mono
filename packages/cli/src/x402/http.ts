import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../lib/errors.js';
import { parseBigInt } from './amount.js';
import { encodePaymentPayload } from './scheme-exact-evm.js';
import type { LimitUsage } from './policy.js';
import { asks, checkPolicy, type PolicyContext, type X402Policy } from './policy.js';
import type { Payer } from './payer.js';
import {
  X402_HEADERS,
  isX402Scheme,
  type X402PaymentPayload,
  type X402Scheme,
  type X402PaymentRequired,
  type X402PaymentRequirement,
  type X402SettleResponse,
} from './types.js';

export interface PayAndFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Tool-level caps + allowlists. */
  policy?: X402Policy;
  /** Base units already spent this session (for `maxTotalPerSession`). */
  spentThisSession?: bigint;
  /** Every limit on the payment token with what has been drawn against it. */
  periodUsage?: LimitUsage[];
  /**
   * Stop after choosing a requirement: no funding, no signature, no money. The
   * same request, challenge parse and policy evaluation a real payment runs, so
   * a clean dry run means a real one would have been allowed too.
   */
  dryRun?: boolean;
  /** Hard ceiling for this single call, on top of the policy. */
  maxAmount?: string;
  /** Require a specific asset (contract address). */
  asset?: string;
  /** Require a specific CAIP-2 network. */
  network?: string;
  /**
   * Optional funding hook, run after the policy approved a requirement and
   * before the payment is signed. Flow 2b plugs the permission top-up in here;
   * a `{ok:false}` outcome becomes a refusal with its reason, never a throw.
   */
  ensureFunds?: (
    requirement: X402PaymentRequirement,
    payerAddress: `0x${string}`
  ) => Promise<{
    ok: boolean;
    reason?: string;
    amount?: string;
    batchId?: string;
    approvalBatchId?: string;
    /** The payer's Permit2 allowance as the hook last saw it, so the signer need not re-read it. */
    permit2Allowance?: bigint;
    skipped?: boolean;
  }>;
}

/** A payment as built/signed — the fields needed to audit or reconcile it. */
export interface PaymentDetails {
  /**
   * Which scheme produced this. Carried because the two figures below mean
   * different things depending on it, and every surface that shows them has to
   * say which it is showing.
   */
  scheme: X402Scheme;
  /**
   * What actually left the payer, once the receipt says. Equal to `authorized`
   * under `exact`, and until settlement reports otherwise under `upto`.
   */
  amount: string;
  /** The ceiling the signature authorized. What a failed attempt still costs. */
  authorized: string;
  /** When the authorization expires, for reconciling an ambiguous settlement. */
  deadline?: string;
  asset: string;
  network: string;
  payTo: string;
  /** The EIP-3009 nonce — lets you reconcile an on-chain transfer to this attempt. */
  nonce: `0x${string}`;
  /** Settlement tx hash, once the server reports it. */
  txHash?: string;
}

export interface PayAndFetchResult {
  status: number;
  body: unknown;
  /** True once a payment was made and the resource returned. */
  paid: boolean;
  /** The address funds are paid from — where the agent's USDC must live. */
  payer: `0x${string}`;
  /** Present on a successful payment. */
  payment?: PaymentDetails;
  /**
   * Present when a payment was signed and sent but settlement did not confirm.
   * In pull mode the facilitator may still have broadcast the transfer, so this
   * carries the nonce/amount to reconcile against — never assume no money moved.
   */
  attemptedPayment?: PaymentDetails;
  /**
   * Present when the payer was refilled from the user's account through the
   * on-chain permission before this payment. User funds moved: always surfaced.
   */
  topUp?: { amount?: string; batchId?: string };
  /**
   * Present when the payer granted Permit2 its allowance as part of this
   * payment. No principal moves, but it is a userOp charged to the payer's
   * USDC, so it is surfaced and logged rather than left invisible: an approval
   * that runs with no top-up beside it would otherwise reach neither the CLI
   * output nor the ledger.
   */
  permit2Approval?: { batchId: string };
  /** Set when a `402` could not (or should not) be paid. */
  refusedReason?: string;
  /**
   * On a `dryRun`, the requirement that would have been paid. Absent when the
   * resource was free or the policy refused (see `refusedReason`). Carries
   * neither nonce nor deadline, deliberately: both only exist once an
   * authorization is signed, and a dry run never signs one.
   */
  wouldPay?: Omit<PaymentDetails, 'nonce' | 'deadline'>;
}

const b64json = <T>(header: string | null): T | null => {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString()) as T;
  } catch {
    return null;
  }
};

/**
 * The nonce that identifies this attempt on chain, whichever scheme produced it:
 * EIP-3009 carries its own, Permit2 carries the one its bitmap consumes. Both
 * are what an ambiguous settlement is reconciled by, so the ledger records
 * either without caring which scheme it came from.
 */
function paymentNonceOf(payload: X402PaymentPayload): `0x${string}` {
  const inner = payload.payload;
  return 'authorization' in inner ? inner.authorization.nonce : inner.permit2Authorization.nonce;
}

/** When the signed authorization stops being spendable, whichever scheme it is. */
function paymentDeadlineOf(payload: X402PaymentPayload): string {
  const inner = payload.payload;
  return 'authorization' in inner ? inner.authorization.validBefore : inner.permit2Authorization.deadline;
}

/**
 * What actually settled.
 *
 * Under `exact` the receipt is a confirmation and never a source. The
 * authorization was for one fixed value and that is the value that moved, so a
 * server reporting something smaller there would be talking our own spend caps
 * down for free.
 *
 * Under `upto` the server does choose the figure, anywhere from zero to the
 * ceiling, and the receipt is the only place it exists, so it is read. A receipt
 * that omits it, or claims more than was authorized, falls back to the whole
 * ceiling: the one direction a server must not be able to move this number is
 * downward without having settled.
 *
 * Exported for its own tests, and covered by them directly because this rule
 * decides how much of a user's budget a server can spend without paying for
 * it. It is the live path: `upto` passes both the policy and the selection, and
 * a full payment runs through here.
 */
export function settledAmountOf(receipt: X402SettleResponse | null, scheme: string, authorized: string): string {
  if (scheme !== 'upto') return authorized;
  // A 200 is not a settlement. Without this a server answers success with
  // `amount: 0`, never calls the proxy, and the cumulative caps never move
  // while it accumulates live authorizations worth the ceiling each, every one
  // of them settleable until its deadline. So the figure may only come down on
  // a receipt that claims success and names something shaped like a
  // transaction; anything else is read as the whole ceiling.
  //
  // Shaped like one is all it is. The hash is never looked up, so this raises
  // the price of under-reporting to fabricating 64 hex characters and does not
  // prove a settlement happened. A server willing to do that reports one base
  // unit against a thousand-unit ceiling, leaves the Permit2 nonce unconsumed,
  // and holds a live authorization for the full ceiling until the deadline
  // while the caps counted one. What still bounds that is the on-chain
  // permission's per-period allowance, which is where the payer's funds come
  // from; what is defeated is this local accounting. Closing it means checking
  // the amount against the transaction the receipt names, which is what the
  // nonce and hash on every ledger row are stored for.
  if (receipt?.success !== true || !settledTxHash(receipt)) return authorized;
  const reported = parseBigInt(receipt.amount ?? '');
  if (reported === null || reported < 0n) return authorized;
  const ceiling = parseBigInt(authorized);
  return ceiling !== null && reported > ceiling ? authorized : reported.toString();
}

/**
 * The settle receipt's tx hash, or nothing when the server sent something that
 * isn't one. Every other field off the wire is shape-checked (`accepts` by
 * `requirementSchema`, addresses by `hexAddress`, `network` by the CAIP-2
 * regex); this one is decoded from a bare base64 header and then reaches a
 * terminal line (`x402 pay` prints it unsanitized, so `\x1b[2K\r` would repaint
 * what the CLI just wrote) and the MCP meta block, which claims to hold only
 * validated shapes that cannot carry an instruction. Checking it here is what
 * makes that claim true, and closes every sink at once. A receipt that fails
 * the check still reconciles by nonce, which the ledger also records.
 */
function settledTxHash(receipt: X402SettleResponse | null): `0x${string}` | undefined {
  const tx = receipt?.transaction;
  return tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : undefined;
}

// Cap the response body a server can make us buffer. The body is untrusted and
// only ever carries a small JSON envelope; without a cap a malicious server
// could stream gigabytes and OOM the agent process.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readBody(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream (e.g. a mocked response): fall back to text() but still guard.
    const text = await res.text();
    if (text.length === 0) return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: `response body exceeded ${MAX_BODY_BYTES} bytes` };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Node's fetch has NO default timeout. A server that accepts the connection and
// never responds would otherwise hang the call forever — and because payments
// run inside a serialization mutex (see registerPayTool), one hung request
// would wedge EVERY subsequent payment. Bound every request so the mutex always
// makes progress.
const FETCH_TIMEOUT_MS = 30_000;

/** A response, already read, with the headers still available to inspect. */
interface FetchedResponse {
  status: number;
  url: string;
  headers: Headers;
  body: unknown;
}

/**
 * `fetch` resolves as soon as the HEADERS arrive, so a timeout that stops there
 * leaves the body read bounded by size but not by time: a server that trickles
 * one byte a minute holds the payment mutex open forever. That is worse than a
 * hang. After a settled payment the ledger append never runs, another process
 * judges the lock stale at 300s and breaks it, and both payments clear the cap.
 * So the body is read here, under the same deadline as the request, and callers
 * get it already in hand.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<FetchedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown;
    try {
      body = await readBody(res);
    } catch (err) {
      // An abort mid-body is our own deadline, not a caller error. Report it as
      // body content the way an oversized body is: throwing here would escape
      // `payAndFetch` after settlement and lose a paid payment's record, which
      // is exactly the trace the ledger needs.
      if (!controller.signal.aborted) throw err;
      body = { error: `response body timed out after ${FETCH_TIMEOUT_MS}ms` };
    }
    return { status: res.status, url: res.url, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Whether a URL is safe to SIGN a payment for. A payment over cleartext http
 * lets a network attacker rewrite the 402 challenge's payTo and walk off with
 * the signed authorization, so only TLS is trusted — except loopback, where
 * there is no wire to tamper with (local dev/test servers). Free (non-402)
 * fetches are unaffected; this gate is only consulted before signing.
 */
function isPaymentUrlSecure(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'https:') return true;
    if (protocol === 'http:') return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    return false;
  } catch {
    return false;
  }
}

function idempotencyKey(): string {
  return `jaw-${randomBytes(6).toString('hex')}`;
}

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address') as unknown as z.ZodType<`0x${string}`>;

/**
 * Shape of one server-supplied `accepts` entry. The challenge is untrusted
 * input: validating here turns a malformed option into one clear refusal
 * reason instead of a confusing failure deeper in the signing path. `scheme`
 * stays a plain string so unsupported schemes still get their own message.
 * The parsed object is echoed back to the server as `accepted`, which must
 * match the option as-advertised — hence passthrough (unknown fields survive)
 * and no defaults (nothing is injected that was not on the wire).
 */
const requirementSchema = z
  .object({
    scheme: z.string(),
    // CAIP-2 (`namespace:reference`). Left as a free string, an unknown
    // network flowed verbatim into the refusal reason, the ledger, and every
    // later `x402 log`. Constrained at the boundary so it cannot carry a
    // payload at all, which is cheaper than trusting each sink to disarm it.
    network: z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, 'must be a CAIP-2 network id'),
    amount: z.string().regex(/^\d+$/, 'amount must be a base-10 integer string'),
    asset: hexAddress,
    payTo: hexAddress,
    // int + finite: a server sending Infinity/NaN/float here would otherwise
    // reach BigInt(validBefore) in the signer and throw an obscure error.
    maxTimeoutSeconds: z.number().int().nonnegative().finite().optional(),
    extra: z.record(z.unknown()).optional(),
  })
  .passthrough();

interface Selection {
  requirement?: X402PaymentRequirement;
  reason?: string;
}

/**
 * Pick the CHEAPEST `accepts` entry that satisfies the caller constraints +
 * policy. Choosing the lowest amount (rather than the first that passes) means a
 * multi-option server can't steer the agent onto a pricier option.
 *
 * Across schemes the comparison is on the same field, which is a price under
 * `exact` and a ceiling under `upto`. That deliberately minimises what gets
 * authorized rather than what is expected to be paid: an agent cannot predict
 * its own consumption, and the number a signature is worth if it is misused is
 * the ceiling. Equal figures break toward `exact` for the same reason, so a
 * server cannot dangle a matching ceiling to move us onto the larger
 * authorization.
 */
function selectRequirement(accepts: unknown[], opts: PayAndFetchOptions, ctx: PolicyContext): Selection {
  const policy = opts.policy ?? {};
  let reason = 'no acceptable payment option in the 402 challenge';
  let best: X402PaymentRequirement | undefined;
  let bestAmount = 0n;

  for (const raw of accepts) {
    const parsed = requirementSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      reason = `malformed payment option${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}`;
      continue;
    }
    const req = parsed.data as X402PaymentRequirement;
    if (!isX402Scheme(req.scheme)) {
      reason = `unsupported scheme: ${String(req.scheme)}`;
      continue;
    }
    if (opts.network && req.network !== opts.network) {
      reason = `network ${req.network} does not match requested ${opts.network}`;
      continue;
    }
    if (opts.asset && req.asset.toLowerCase() !== opts.asset.toLowerCase()) {
      reason = `asset ${req.asset} does not match requested ${opts.asset}`;
      continue;
    }

    const amount = parseBigInt(req.amount);
    if (amount === null) {
      reason = `invalid amount: ${req.amount}`;
      continue;
    }
    if (opts.maxAmount !== undefined) {
      const cap = parseBigInt(opts.maxAmount);
      if (cap === null) {
        reason = `invalid maxAmount: ${opts.maxAmount}`;
        continue;
      }
      if (amount > cap) {
        reason = `amount ${asks(req)} exceeds maxAmount ${opts.maxAmount}`;
        continue;
      }
    }

    const verdict = checkPolicy(req, policy, ctx);
    if (!verdict.ok) {
      reason = verdict.reason ?? reason;
      continue;
    }

    const cheaper = !best || amount < bestAmount;
    const fixedPriceTie = !!best && amount === bestAmount && best.scheme === 'upto' && req.scheme === 'exact';
    if (cheaper || fixedPriceTie) {
      best = req;
      bestAmount = amount;
    }
  }

  return best ? { requirement: best } : { reason };
}

/**
 * Fetch a resource, paying an x402 `402` challenge with the given payer when one
 * appears. Free resources pass straight through (this doubles as a generic
 * fetch). On a `402` it parses the challenge, selects an option that satisfies
 * the constraints + policy (never overpaying), builds and signs the payment, and
 * retries with `PAYMENT-SIGNATURE`. Settlement failures surface a reason rather
 * than blind-retrying.
 */
export async function payAndFetch(
  url: string,
  payer: Payer,
  opts: PayAndFetchOptions = {}
): Promise<PayAndFetchResult> {
  const method = opts.method ?? 'GET';
  const baseHeaders: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };

  // 1. First attempt. Anything but 402 passes through unchanged.
  const first = await fetchWithTimeout(url, { method, headers: baseHeaders, body: opts.body });
  if (first.status !== 402) {
    return { status: first.status, body: first.body, paid: false, payer: payer.address };
  }

  // Every refusal below answers the same way: the challenge stands, nothing was
  // paid, and the reason says why. Naming the shape once leaves each site
  // showing only what makes it different.
  const refusal = (refusedReason: string | undefined, extra?: Partial<PayAndFetchResult>): PayAndFetchResult => ({
    status: 402,
    body: first.body,
    payer: payer.address,
    refusedReason,
    ...extra,
    // After the spread, never from it. Both front ends decide whether to write a
    // settled row in the ledger from this field, and the ledger is what the caps
    // are rebuilt from, so a refusal must not be able to claim a payment.
    paid: false,
  });

  // A 402 means we are about to sign a payment. Gate on the FINAL url (after
  // any redirects), not the original: fetch follows https->http downgrades by
  // default, so a trusted https endpoint that redirects to http would smuggle a
  // cleartext challenge past a check on the original url. `resource` is also
  // what the policy host allowlist must judge, and where the signed proof is
  // sent (never the original, which could redirect again). Free (non-402)
  // fetches returned above, so plain http still works as a generic fetch.
  const resource = first.url || url;
  if (!isPaymentUrlSecure(resource)) {
    return refusal('refusing to sign a payment over a non-HTTPS URL (use https, or localhost for testing)');
  }

  // 2. The v2 challenge lives in the PAYMENT-REQUIRED header (body is opaque).
  const challenge = b64json<X402PaymentRequired>(first.headers.get(X402_HEADERS.required));
  if (!challenge || !Array.isArray(challenge.accepts)) {
    return refusal('missing or malformed PAYMENT-REQUIRED challenge');
  }

  // 3. Choose an option under the constraints + policy, or refuse clearly.
  const ctx: PolicyContext = {
    host: hostOf(resource),
    spentThisSession: opts.spentThisSession,
    periodUsage: opts.periodUsage,
  };
  const { requirement, reason } = selectRequirement(challenge.accepts, opts, ctx);
  if (!requirement) {
    return refusal(reason);
  }

  // 3.75 Dry run stops here, the last point before anything costs or commits.
  //      Funding moves user money and signing produces a spendable
  //      authorization, so both are past the line.
  if (opts.dryRun) {
    return {
      status: 402,
      body: first.body,
      paid: false,
      payer: payer.address,
      wouldPay: {
        scheme: requirement.scheme,
        amount: requirement.amount,
        authorized: requirement.amount,
        asset: requirement.asset,
        network: requirement.network,
        payTo: requirement.payTo,
      },
    };
  }

  // 3.5 Funding hook (flow 2b): make sure the payer can actually cover the
  //     price, topping it up through the on-chain permission when it can't.
  //     A refusal here is a policy-shaped outcome, not an error.
  let topUp: { amount?: string; batchId?: string } | undefined;
  let permit2Approval: { batchId: string } | undefined;
  let permit2Allowance: bigint | undefined;
  if (opts.ensureFunds) {
    // Wrapped for the same reason `payer.pay` is below: this hook is what moves
    // the funds, so a throw escaping here skips both front ends' audit log for
    // money that already left. An RPC failure in the balance read or a missing
    // call status is enough to trip it.
    let funded;
    try {
      funded = await opts.ensureFunds(requirement, payer.address);
    } catch (err) {
      return refusal(`payer funding failed: ${errorMessage(err)}`);
    }
    if (!funded.ok) {
      // A refused funding may still have broadcast the transfer (e.g. a
      // confirmation timeout) — keep the trace so it can be reconciled. Gated
      // on either field: the no-call-id path has an amount and no id.
      return refusal(funded.reason ?? 'payer funding failed', {
        ...(funded.amount || funded.batchId ? { topUp: { amount: funded.amount, batchId: funded.batchId } } : {}),
        ...(funded.approvalBatchId ? { permit2Approval: { batchId: funded.approvalBatchId } } : {}),
      });
    }
    // Independent of `skipped`: the approval runs whether or not principal had
    // to move, and it is money out of the payer either way.
    if (funded.approvalBatchId) {
      permit2Approval = { batchId: funded.approvalBatchId };
    }
    permit2Allowance = funded.permit2Allowance;
    if (!funded.skipped) {
      topUp = { amount: funded.amount, batchId: funded.batchId };
    }
  }

  // 4. Build + sign the payment. Keep the payload so the nonce is recoverable
  //    even if settlement later fails (money may still have moved in pull mode).
  //    A throw here (e.g. an eip712Domain read revert on a delegated payer)
  //    after a top-up already moved funds must NOT escape as a bare exception:
  //    surface it as a structured refusal carrying the topUp trace so the
  //    caller records the moved funds in the audit ledger.
  let payload;
  try {
    payload = await payer.pay(requirement, { permit2Allowance });
  } catch (err) {
    return refusal(`payment signing failed: ${errorMessage(err)}`, { topUp, permit2Approval });
  }
  const details = {
    scheme: requirement.scheme,
    // The ceiling until a receipt says otherwise, which is the conservative
    // reading for `upto` and the exact figure for `exact`.
    amount: requirement.amount,
    authorized: requirement.amount,
    deadline: paymentDeadlineOf(payload),
    asset: requirement.asset,
    network: requirement.network,
    payTo: requirement.payTo,
    nonce: paymentNonceOf(payload),
  };
  const proof = encodePaymentPayload(payload);

  // 5. Retry with the proof, against the resolved secure `resource` and with
  //    redirects DISABLED: the PAYMENT-SIGNATURE header must never be followed
  //    onto another origin (undici keeps custom headers across cross-origin
  //    redirects), which would hand the signed proof to an attacker. A fresh
  //    nonce means the server's replay protection is fine with the re-request.
  const retryHeaders: Record<string, string> = {
    ...baseHeaders,
    [X402_HEADERS.signature]: proof,
    'Idempotency-Key': idempotencyKey(),
  };
  // Wrapped like `ensureFunds` and `payer.pay` above, and for more than either:
  // by this point a top-up may have moved the user's USDC and the authorization
  // is already signed, so a socket error escaping here loses both from the audit
  // ledger. That ledger is what the period and session caps are rebuilt from, so
  // the next payment would see a ceiling more permissive than it should.
  let paid;
  try {
    paid = await fetchWithTimeout(resource, {
      method,
      headers: retryHeaders,
      body: opts.body,
      redirect: 'manual',
    });
  } catch (err) {
    return refusal(`payment sent but the response never arrived: ${errorMessage(err)}`, {
      body: '',
      attemptedPayment: details,
      topUp,
      permit2Approval,
    });
  }

  // A settled x402 response carries the resource directly (never a redirect).
  // A 3xx here means the endpoint tried to bounce the signed proof elsewhere —
  // treat it as a settlement failure, never follow it.
  if (paid.status >= 300 && paid.status < 400) {
    return {
      status: paid.status,
      body: paid.body,
      paid: false,
      payer: payer.address,
      attemptedPayment: details,
      topUp,
      permit2Approval,
      refusedReason: `settlement endpoint attempted a redirect (${paid.status}); not following it with the signed proof`,
    };
  }

  const receipt = b64json<X402SettleResponse>(paid.headers.get(X402_HEADERS.response));
  const body = paid.body;
  if (paid.status >= 400) {
    // On rejection the server re-challenges with a fresh PAYMENT-REQUIRED whose
    // `error` carries the real reason (e.g. `invalid_exact_evm_insufficient_balance`),
    // which is far more actionable than the bare status. Prefer a settle receipt
    // error, then the re-challenge error, then the status.
    const reChallenge = b64json<X402PaymentRequired>(paid.headers.get(X402_HEADERS.required));
    return {
      status: paid.status,
      body,
      paid: false,
      payer: payer.address,
      // The payment was signed and sent; surface it so an ambiguous settlement
      // (facilitator may have broadcast) can be reconciled by nonce.
      attemptedPayment: details,
      topUp,
      permit2Approval,
      refusedReason: receipt?.errorReason ?? reChallenge?.error ?? `settlement failed with status ${paid.status}`,
    };
  }

  return {
    status: paid.status,
    body,
    paid: true,
    topUp,
    permit2Approval,
    payer: payer.address,
    payment: {
      ...details,
      amount: settledAmountOf(receipt, requirement.scheme, details.authorized),
      txHash: settledTxHash(receipt),
    },
  };
}
