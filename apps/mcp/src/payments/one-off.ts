import { randomBytes } from 'node:crypto';
import {
  chooseOneOff,
  openPaymentRequest,
  payAndFetch,
  paymentDraft,
  probe,
  signedExact,
  stillOffered,
  toSignedAuthorization,
  until,
  type ApprovalId,
  type ApprovalRequest,
  type Challenge,
  type Payer,
  type PaymentBody,
} from '@jaw.id/agent';
import type { Address } from 'viem';
import { insertUnderCap, MAX_PENDING, sellerRequestOf } from '@/approvals/store';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { isPaymentsPaused } from '@/db/settings';
import { log } from '@/lib/edge';
import { safeFetch } from '@/lib/safe-fetch';
import { concludeSend, resend, thrown } from './pay';
import { render, type OneOffOffer, type PayResult } from './render';
import {
  findByApproval,
  findPayment,
  finish,
  LEASE_MS,
  markSigned,
  PAY_LIMIT_MS,
  requestHash,
  take,
  type NewOneOff,
  type PaymentRequest,
  type PaymentRow,
  type SellerRequest,
} from './store';

export type PaymentApproval = ApprovalRequest & { body: PaymentBody };

interface OneOffDeps {
  fetch: typeof fetch;
  now: () => Date;
}

const liveDeps = (): OneOffDeps => ({ fetch: safeFetch(config().insecureFetchHosts), now: () => new Date() });

// The account pays with the owner's signature from the approval page; this payer only sends it again.
const accountPayer = (account: Address): Payer => ({
  address: account,
  pay: () => Promise.reject(new Error('a one-off is signed on the approval page')),
});

export const oneOffFor = (t: Tenant, request: PaymentRequest, challenge: Challenge) =>
  chooseOneOff(challenge, { network: `eip155:${t.chainId}`, maxAmount: request.maxAmount });

/** On budget_exhausted or over_cap: open a one-off approval for the challenge just refused, or nothing. Never throws. */
export async function offerOneOff(
  t: Tenant,
  request: PaymentRequest,
  challenge: Challenge
): Promise<OneOffOffer | undefined> {
  try {
    const requirement = oneOffFor(t, request, challenge);
    if (!requirement) return undefined;
    const approval = openPaymentRequest(
      {
        id: randomBytes(16).toString('base64url') as ApprovalId,
        account: t.account,
        chainId: t.chainId,
        requester: { name: t.clientName, clientId: t.clientId },
        sessionAddress: t.sessionAddress,
      },
      { resource: challenge.resource, requirement },
      new Date()
    );
    const seller: SellerRequest = { method: request.method, headers: request.headers, body: request.body };
    if (!approval || !(await insertUnderCap(t.connectionId, approval, MAX_PENDING, seller))) return undefined;
    return { requestId: approval.id, approveUrl: `${config().keysOrigin}/approve/${approval.id}` };
  } catch (err) {
    // The name only: a failed insert quotes its parameters, the agent's headers among them.
    log('warn', { msg: 'one-off not offered', error: err instanceof Error ? err.name : 'unknown' });
    return undefined;
  }
}

/** The payments row an approval opens, inserted in the transaction that records it. */
export function oneOffRow(approval: PaymentApproval, seller: SellerRequest): NewOneOff & { leaseToken: string } {
  const { resource } = approval.body.terms;
  return {
    id: `pay_${randomBytes(16).toString('base64url')}`,
    // Outside the alphabet jaw_pay_and_fetch accepts for a key, so no tool call can claim this row.
    idempotencyKey: `approval/${approval.id}`,
    requestHash: requestHash({ url: resource, ...seller }),
    approvalId: approval.id,
    payer: approval.account.toLowerCase(),
    url: resource,
    leaseToken: randomBytes(16).toString('base64url'),
  };
}

/**
 * Owns a pending one-off row under `token`. Asks the seller again and sends the
 * owner's signature only when the fresh challenge still offers what was signed;
 * every earlier stop sends nothing. A paid row stays signed for the reconciler.
 */
export async function runOneOff(
  approval: PaymentApproval,
  seller: SellerRequest,
  rowId: string,
  token: string,
  deps: OneOffDeps = liveDeps()
): Promise<{ row: PaymentRow; fenced: string[] }> {
  const { state } = approval;
  if (state.status !== 'approved' || state.evidence.proof.type !== 'signature') {
    throw new Error('a one-off runs only after a signed approval');
  }
  const row = (await findPayment(rowId)) as PaymentRow;
  const refuse = async (code: string) => {
    const written = await finish(row.id, token, { state: 'failed', kind: 'refused', code }, []);
    return { row: written ?? ((await findPayment(row.id)) as PaymentRow), fenced: [] };
  };

  const started = deps.now();
  if (started.getTime() >= approval.expiresAt.getTime() + LEASE_MS) return refuse('challenge_expired');
  const { terms } = approval.body;
  const sent = { ...seller, budget: until(started.getTime() + PAY_LIMIT_MS), fetch: deps.fetch };
  const probed = await probe(terms.resource, sent).catch(thrown);
  switch (probed.kind) {
    case 'unreached':
      return refuse(probed.code);
    case 'free':
      return concludeSend(row, token, { ...probed, payer: approval.account }, { signed: false, signedAt: started });
    case 'refused':
      return refuse(probed.refusal.code);
  }
  const fresh = stillOffered(terms, probed.challenge);
  if (!fresh) return refuse('price_changed');

  const draft = paymentDraft(approval.account, terms);
  const authorization = toSignedAuthorization(
    terms.resource,
    signedExact(draft, state.evidence.proof.signature, fresh)
  );
  try {
    await markSigned(row.id, token, authorization);
  } catch {
    return { row: (await findPayment(row.id)) as PaymentRow, fenced: [] };
  }
  const outcome = await payAndFetch(terms.resource, accountPayer(approval.account), {
    ...sent,
    attempt: { key: row.id, resume: authorization },
  }).catch(thrown);
  return concludeSend(row, token, outcome, { signed: true, signedAt: started });
}

/**
 * What an approved one-off came to, for jaw_request_status. Also the recovery
 * path: a row stranded pending by a crash runs now, and a signed row whose
 * answer was lost is sent again under the same key.
 */
export async function oneOffStatus(
  approval: PaymentApproval,
  deps: OneOffDeps = liveDeps()
): Promise<PayResult | undefined> {
  const row = await findByApproval(approval.id);
  if (!row) return undefined;
  if (!row.sendable || (await isPaymentsPaused())) return render(row, row.fenced ?? []);
  const taken = await take(row);
  if (!taken) return render(row, []);

  const seller = await sellerRequestOf(approval.id);
  if (taken.row.state === 'signed') {
    const sent = { ...seller, budget: until(Date.now() + PAY_LIMIT_MS), fetch: deps.fetch };
    return resend(taken.row, taken.token, accountPayer(approval.account), sent);
  }
  const done = await runOneOff(approval, seller, taken.row.id, taken.token, deps);
  return render(done.row, done.fenced);
}
