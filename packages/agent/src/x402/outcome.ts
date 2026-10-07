import type { X402Scheme } from './types.js';

/**
 * Why a payment did not happen, for code to branch on. The reason text beside
 * it is what a person reads, and is unchanged from 0.4.0. Codes only a host can
 * decide before calling (`no_grant`, `payments_paused`) belong to the host.
 *
 * A refusal carrying a `topUp` or `permit2Approval` trace moved money before
 * it stopped, whatever its code: retrying it can refill the payer twice.
 */
export type RefusalCode =
  // Before anything was signed.
  | 'insecure_url'
  | 'blocked_url'
  | 'malformed_challenge'
  | 'no_option'
  | 'unsupported_option'
  | 'network_mismatch'
  | 'asset_mismatch'
  | 'not_allowed'
  | 'over_cap'
  | 'budget_exhausted'
  | 'invalid_config'
  | 'funding_failed'
  | 'balance_low'
  | 'chain_unavailable'
  | 'signing_failed'
  | 'store_failed'
  | 'authorization_expired'
  | 'timed_out'
  // After the proof was sent: money may have moved.
  | 'no_response'
  | 'redirected'
  | 'settlement_rejected';

export interface Refusal {
  code: RefusalCode;
  /** Can carry server text. Every sink sanitizes it, as before. */
  reason: string;
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

/** User money that moved before the end state. Always surfaced, never dropped. */
export interface Traces {
  /** The payer was refilled from the user's account through the on-chain permission. */
  topUp?: { amount?: string; batchId?: string };
  /** The payer granted Permit2 its allowance: no principal, but a userOp the payer paid for. */
  permit2Approval?: { batchId: string };
}

interface Fetched {
  status: number;
  body: unknown;
  /** The address funds are paid from — where the agent's USDC must live. */
  payer: `0x${string}`;
}

/**
 * What one call to `payAndFetch` came to. `kind` says what happened to money:
 * `free`, `would-pay` and `refused` sent no authorization; `failed` sent one
 * that did not confirm, so it may still settle and carries what to reconcile;
 * `paid` got the resource for it.
 */
export type PaymentOutcome =
  | ({ kind: 'free' } & Fetched)
  | ({ kind: 'would-pay'; wouldPay: Omit<PaymentDetails, 'nonce' | 'deadline'> } & Fetched)
  | ({ kind: 'refused'; refusal: Refusal } & Fetched & Traces)
  | ({ kind: 'failed'; refusal: Refusal; attempted: PaymentDetails } & Fetched & Traces)
  | ({ kind: 'paid'; payment: PaymentDetails } & Fetched & Traces);

/** The record `jaw x402 pay` and `jaw_pay_and_fetch` print, unchanged from 0.4.0. */
export interface PayAndFetchResult extends Fetched, Traces {
  /** True once a payment was made and the resource returned. */
  paid: boolean;
  payment?: PaymentDetails;
  /**
   * A payment was signed and sent but settlement did not confirm. The
   * facilitator may still have broadcast the transfer, so this carries the
   * nonce and amount to reconcile against — never assume no money moved.
   */
  attemptedPayment?: PaymentDetails;
  refusedReason?: string;
  /** On a dry run, the requirement that would have been paid. */
  wouldPay?: Omit<PaymentDetails, 'nonce' | 'deadline'>;
}

/**
 * The 0.4.0 record, built in the key order each branch used then: that order
 * is what `-o json` prints and agents parse. `http.golden.test.ts` holds it.
 */
export function toPayAndFetchResult(outcome: PaymentOutcome): PayAndFetchResult {
  const { status, body, payer } = outcome;
  switch (outcome.kind) {
    case 'free':
      return { status, body, paid: false, payer };
    case 'would-pay':
      return { status, body, paid: false, payer, wouldPay: outcome.wouldPay };
    case 'refused':
      return { status, body, payer, refusedReason: outcome.refusal.reason, ...traces(outcome), paid: false };
    case 'failed':
      // A proof that got no answer was reported in the refusal's order.
      if (outcome.refusal.code === 'no_response') {
        const { topUp, permit2Approval } = outcome;
        return {
          status,
          body,
          payer,
          refusedReason: outcome.refusal.reason,
          attemptedPayment: outcome.attempted,
          topUp,
          permit2Approval,
          paid: false,
        };
      }
      return {
        status,
        body,
        paid: false,
        payer,
        attemptedPayment: outcome.attempted,
        topUp: outcome.topUp,
        permit2Approval: outcome.permit2Approval,
        refusedReason: outcome.refusal.reason,
      };
    case 'paid':
      return {
        status,
        body,
        paid: true,
        topUp: outcome.topUp,
        permit2Approval: outcome.permit2Approval,
        payer,
        payment: outcome.payment,
      };
  }
}

/** Only the traces present, so a refusal prints no empty keys. */
function traces({ topUp, permit2Approval }: Traces): Traces {
  return { ...(topUp ? { topUp } : {}), ...(permit2Approval ? { permit2Approval } : {}) };
}
