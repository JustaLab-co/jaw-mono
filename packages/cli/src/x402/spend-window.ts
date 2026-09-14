import { currentPeriodWindow, normalizePeriod } from './period.js';
import { sumSpentSince, sumToppedUpSince, type SpendScope, type X402LogEntry } from './ledger.js';
import { parseBigInt } from './amount.js';
import { readCurrentPeriods, type ReadDeps } from './permission-onchain.js';
import { USDC_BY_NETWORK } from './asset-registry.js';
import type { LimitUsage, X402Policy } from './policy.js';
import type { SessionConfig } from '../lib/session-config.js';

/**
 * What every limit on the payment token has already lost, in the window each of
 * them is currently in.
 *
 * A list rather than one figure, because the contract charges every limit whose
 * token matches and each keeps its own counter. Reducing them to one number
 * meant answering "what refuses this payment" and "what runs out first" with
 * the same value, and those come apart: 50 a day beside 100 a month reported
 * the 50 and overstated the month fifteenfold.
 *
 * The entries are the caller's snapshot of the ledger, so one payment reads the
 * file once for however many limits it has. It has to be taken per payment and
 * inside the payment lock, never cached across them: another process holding the
 * lock before us may have spent inside these windows too.
 */
export function currentLimitUsage(
  entries: X402LogEntry[],
  policy: X402Policy,
  payerAddress: string,
  session: { expiry: number; permissionId?: string } | null | undefined,
  now: Date = new Date()
): LimitUsage[] {
  if (!session || !policy.perPeriod) return [];

  const scope: SpendScope = { permissionId: session.permissionId, payer: payerAddress };
  const usage: LimitUsage[] = [];
  for (const limit of policy.perPeriod) {
    const anchorMs = Date.parse(limit.anchor);
    // A hand-edited anchor must degrade to "no window for this limit", never
    // throw and take down every payment.
    if (Number.isNaN(anchorMs)) continue;
    const window = currentPeriodWindow({
      anchor: Math.floor(anchorMs / 1000),
      unit: limit.unit,
      multiplier: limit.multiplier,
      now: Math.floor(now.getTime() / 1000),
      permissionEnd: session.expiry,
    });
    const since = new Date(window.start * 1000).toISOString();
    usage.push({
      ...limit,
      spent: sumSpentSince(entries, scope, since),
      toppedUp: sumToppedUpSince(entries, scope, since),
      startedAt: new Date(window.start * 1000),
      endsAt: new Date(window.end * 1000),
      source: 'ledger',
    });
  }
  return usage;
}

/**
 * The same list, asked of the chain first.
 *
 * The ledger undercounts by construction: it sees what went through
 * `payAndFetch` and nothing else, so a pull made by a `wallet_sendCalls` sent
 * through `jaw_rpc`, by a second machine, or by a write that never landed is
 * missing from it.
 *
 * Per limit, the two figures are combined rather than one replacing the other,
 * because each is ahead of the other in a different case. The chain is ahead
 * when something outside this CLI drew on the permission; the ledger is ahead
 * when our own top-up is signed and not yet mined. The larger is the only one
 * safe against both.
 *
 * A limit whose counter could not be read falls back to the ledger for that
 * limit alone. A node being down must not tighten a cap.
 */
export async function currentLimitUsageOnChain(
  entries: X402LogEntry[],
  policy: X402Policy,
  payerAddress: string,
  session: SessionConfig | null | undefined,
  now: Date = new Date(),
  deps: ReadDeps = {}
): Promise<LimitUsage[]> {
  const local = currentLimitUsage(entries, policy, payerAddress, session, now);
  if (!session || local.length === 0) return local;

  const scope: SpendScope = { permissionId: session.permissionId, payer: payerAddress };

  // The same token the policy was seeded from, resolved the same way.
  const asset = Object.values(USDC_BY_NETWORK).find((a) => a.chainId === session.chainId);
  if (!asset) return local;

  const onChain = await readCurrentPeriods(
    {
      chainId: session.chainId,
      permissionId: session.permissionId,
      permission: session.permission,
      token: asset.address,
    },
    deps
  );
  if (onChain.length === 0) return local;

  return local.map((limit) => {
    // Matched on the window and the allowance rather than on position, since
    // the policy skips limits it cannot normalise and the chain list does not.
    const match = onChain.find((candidate) => {
      const normalized = normalizePeriod(candidate.unit, candidate.multiplier);
      if (normalized?.unit !== limit.unit || normalized.multiplier !== limit.multiplier) return false;
      // Not `BigInt(...)` directly: these strings come off disk, and throwing
      // here rejects the whole call and takes down a payment the ledger figure
      // would have served.
      const a = parseBigInt(candidate.allowance);
      const b = parseBigInt(limit.allowance);
      return a !== null && b !== null && a === b;
    });
    if (!match || match.period.status !== 'ok') return limit;

    const since = new Date(match.period.start * 1000).toISOString();
    const fromLedger = sumToppedUpSince(entries, scope, since);
    const metered = match.period.spend >= fromLedger;
    return {
      ...limit,
      spent: sumSpentSince(entries, scope, since),
      toppedUp: metered ? match.period.spend : fromLedger,
      startedAt: new Date(match.period.start * 1000),
      endsAt: new Date(match.period.end * 1000),
      source: metered ? 'chain' : 'ledger',
    };
  });
}

/**
 * Every instant a live cap counts from, which is what a compaction has to cut
 * against.
 *
 * Taken from the usage list the payment just measured with, never recomputed:
 * `currentLimitUsageOnChain` may have taken a window start from the contract
 * rather than from `currentPeriodWindow`, and cutting against a second opinion
 * is how a live cap loses rows it was still counting.
 *
 * A session with no `createdAt` contributes nothing. Its total is summed with
 * no `since` at all, so it counts every row and every checkpoint alike.
 */
export function capWindowStarts(usage: LimitUsage[], sessionCreatedAt: string | undefined): string[] {
  const starts = usage.map((limit) => limit.startedAt.toISOString());
  if (sessionCreatedAt) starts.push(sessionCreatedAt);
  return starts;
}
