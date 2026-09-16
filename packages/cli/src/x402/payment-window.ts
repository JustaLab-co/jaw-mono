import { parseNonNegativeBigInt } from './amount.js';
import { readX402Log, sumSpentSince } from './ledger.js';
import { reconcileSettlements } from './settlement.js';
import { currentLimitUsageOnChain } from './spend-window.js';
import { topUpCeiling, type LimitUsage, type X402Policy } from './policy.js';
import { ensurePayerFunds } from './topup.js';
import { SessionBridge } from '../lib/session-bridge.js';
import type { SessionConfig } from '../lib/session-config.js';
import type { X402PaymentRequirement } from './types.js';

/** The funding hook `payAndFetch` runs once a requirement has passed the policy. */
export type EnsureFunds = (
  requirement: X402PaymentRequirement,
  payerAddress: `0x${string}`
) => ReturnType<typeof ensurePayerFunds>;

export interface PaymentWindow {
  /** Measured against `maxTotalPerSession`, so it spans permissions. */
  spentThisSession: bigint;
  /** Every limit on the payment token, with what the window containing now has already lost. */
  periodUsage: LimitUsage[];
  /**
   * Absent on a dry run, which signs nothing, and whenever a refill could not
   * be made anyway: no session to pull through, or no api key to charge its gas
   * to. The callers say which of the two it was, since the two are fixed
   * differently.
   */
  ensureFunds?: EnsureFunds;
}

export interface PaymentWindowInput {
  session: SessionConfig | null;
  policy: X402Policy;
  payerAddress: `0x${string}`;
  /**
   * Already resolved by the caller, because the CLI has a flag that overrides
   * it and the MCP server does not. Without a key there is no paymaster to
   * charge a refill's gas to, which is what makes it the top-up's precondition.
   */
  apiKey: string | undefined;
  /** Refill target in base units, straight off config. Parsed here, not by the caller. */
  topUpFloat: string | undefined;
  /** A dry run signs nothing, so it never reaches the funding hook. */
  dryRun?: boolean;
}

/**
 * What a single payment is allowed to spend, read at the moment it is about to.
 *
 * Both front ends need the same three answers and used to work them out
 * separately, in the same order, from the same seven pieces. They drifted: the
 * grant-seeded policy reached the agent and not the terminal, so one session
 * refused at the granted cap in one place and paid under the defaults in the
 * other.
 *
 * Call it inside the payment lock and never cache it across payments. Another
 * process may have paid while we waited our turn, and a stale total waves
 * through a payment the cap should have stopped. Nothing can append while the
 * lock is held, so the session total and every period window count against the
 * same rows.
 *
 * The ledger is reconciled first because an unverified row costs its ceiling,
 * and this is where that figure comes down to what the chain shows actually
 * moved. A dry run does that too, deliberately: the corrections only ever bring
 * a ceiling down, and a rehearsal that skipped them would measure against
 * ceilings the real run would not have.
 */
export async function openPaymentWindow({
  session,
  policy,
  payerAddress,
  apiKey,
  topUpFloat,
  dryRun,
}: PaymentWindowInput): Promise<PaymentWindow> {
  const ledger = await reconcileSettlements(readX402Log());
  const periodUsage = await currentLimitUsageOnChain(ledger, policy, payerAddress, session);
  // Payer, deliberately, with no permission: `session add` preserves
  // `createdAt` so that adding a capability cannot reset the total, and scoping
  // to the new permission would hand back the same clean slate through the
  // other door.
  const spentThisSession = sumSpentSince(ledger, { payer: payerAddress }, session?.createdAt);

  if (dryRun || !session || !apiKey) return { spentThisSession, periodUsage };

  const bridge = new SessionBridge({ apiKey, chainId: session.chainId });
  // Defensive: a hand-edited, non-numeric amount must degrade to "no float",
  // never throw and take down every payment.
  const floatTarget = parseNonNegativeBigInt(topUpFloat);
  // Whatever is left of the tightest resolved cap at this moment, not the full
  // width of the caps, so a float pre-fund is clamped too and not just the
  // payment itself.
  const maxTopUp = topUpCeiling(policy, { periodUsage, spentThisSession });
  const ensureFunds: EnsureFunds = (requirement, payer) =>
    ensurePayerFunds(requirement, payer, bridge, { floatTarget, maxTopUp, sessionChainId: session.chainId });

  return { spentThisSession, periodUsage, ensureFunds };
}
