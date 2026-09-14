import { toFunctionSelector } from 'viem';
import { describeSpendPeriod } from './period.js';
import type { GrantedPermission } from '../lib/session-config.js';
import type { PermissionsConfig } from '../lib/types.js';

/**
 * The union of what a session already grants and what is being added.
 *
 * A session holds one permission, and `session setup` replaces it. An agent
 * that has a scoped session and then discovers it needs to pay had no way to
 * add that: re-running setup revokes the grant it is working under, so it loses
 * its other capabilities mid-task, and the only way to have both was to
 * hand-write the union as one `--permissions` document.
 *
 * The union is computable now only because the granted permission is stored as
 * the contract holds it. Before that the CLI kept a USDC spend limit and
 * nothing else, so the existing scope could not be reconstructed to merge
 * against.
 */

/**
 * A call is the same call when it targets the same function on the same
 * contract.
 *
 * The selector is derived from the signature when that is all an entry carries,
 * which is how the x402 preset writes them while the stored permission carries
 * selectors. Comparing the two forms directly matched nothing, so
 * `session add --x402` was never a no-op: every run re-granted, revoked, cost
 * two browser approvals, and left another copy of the same call on the
 * permission.
 */
function callKey(call: { target: string; selector?: string; functionSignature?: string }): string | null {
  const selector = call.selector ?? (call.functionSignature ? safeSelector(call.functionSignature) : undefined);
  return selector ? `${call.target.toLowerCase()}:${selector.toLowerCase()}` : null;
}

function safeSelector(signature: string): string | undefined {
  try {
    return toFunctionSelector(signature);
  } catch {
    // A signature the SDK will reject later. Left unkeyed rather than thrown on:
    // this is a merge, and the grant is where a bad signature belongs refused.
    return undefined;
  }
}

/**
 * A limit is superseded by one that meters the same token over the same window,
 * and only by that.
 *
 * Keying on the token alone was worse in the other direction: a session holding
 * a monthly budget and a daily one, taking `add --x402` with no `--limit`,
 * dropped both for the preset's default. A command whose whole promise is to
 * add without taking away removed a cap the request never mentioned, and the
 * ceiling cannot catch it, since it compares one entry at a time.
 *
 * What the remaining windows do to each other is real but not this function's
 * to resolve, and `describeMerge` says it out loud:
 * `_checkAndIncrementSpend` charges every limit whose token matches rather than
 * stopping at the first (`JustaPermissionManager.sol:1069`, "Don't break,
 * continue checking all limits for this token"), so limits on one token are
 * ANDed and the tightest binds.
 */
function spendKey(spend: { token: string; unit: string; multiplier?: number }): string {
  return `${spend.token.toLowerCase()}:${spend.unit}:${spend.multiplier ?? 1}`;
}

function tokenKey(spend: { token: string }): string {
  return spend.token.toLowerCase();
}

export function mergePermissions(existing: GrantedPermission, addition: PermissionsConfig): PermissionsConfig {
  // Typed as the wider config shape: an addition may name a call by signature
  // instead of selector, which is what the x402 preset does.
  const calls: NonNullable<PermissionsConfig['calls']> = existing.calls.map((call) => ({
    target: call.target,
    selector: call.selector,
  }));
  const seenCalls = new Set(existing.calls.map(callKey));
  for (const call of addition.calls ?? []) {
    const key = callKey(call);
    if (key && seenCalls.has(key)) continue;
    if (key) seenCalls.add(key);
    calls.push(call);
  }

  const superseded = new Set((addition.spends ?? []).map(spendKey));
  const spends = existing.spends
    .filter((spend) => !superseded.has(spendKey(spend)))
    .map((spend) => ({
      token: spend.token,
      // Normalised out of the hex the grant response carries, so the merged
      // document reads the way a hand-written one does.
      allowance: BigInt(spend.allowance).toString(),
      unit: spend.unit,
      multiplier: spend.multiplier,
    }));
  for (const spend of addition.spends ?? []) {
    spends.push({
      token: spend.token,
      allowance: BigInt(spend.allowance).toString(),
      unit: spend.unit,
      multiplier: spend.multiplier ?? 1,
    });
  }

  // Absent rather than empty. The validator rejects a `spends: []` outright,
  // and a calls-only session merged with a calls-only addition produces exactly
  // that, so such an add throws after the browser has already been opened.
  return {
    ...(calls.length > 0 ? { calls } : {}),
    ...(spends.length > 0 ? { spends } : {}),
  };
}

/** One line per change, for the summary printed before the browser opens. */
export function describeMerge(existing: GrantedPermission, merged: PermissionsConfig): string[] {
  const lines: string[] = [];
  const hadCalls = new Set(existing.calls.map(callKey));
  for (const call of merged.calls ?? []) {
    const key = callKey(call);
    if (key && hadCalls.has(key)) continue;
    lines.push(`  + call    ${call.target} ${call.selector ?? call.functionSignature ?? ''}`.trimEnd());
  }

  const had = new Map(existing.spends.map((spend) => [spendKey(spend), BigInt(spend.allowance)]));
  const changed: Array<{ token: string; allowance: string; unit: string; multiplier?: number }> = [];
  for (const spend of merged.spends ?? []) {
    const was = had.get(spendKey(spend));
    const now = BigInt(spend.allowance);
    if (was === undefined) {
      lines.push(
        `  + spend   ${spend.allowance} of ${spend.token} per ${describeSpendPeriod(spend.unit, spend.multiplier)}`
      );
      changed.push(spend);
    } else if (was !== now) {
      lines.push(
        `  ~ spend   ${spend.token} per ${describeSpendPeriod(spend.unit, spend.multiplier)}: ${was} to ${now}`
      );
      changed.push(spend);
    }
  }

  // Every other limit on the same token, named rather than ranked. All of them
  // are charged, so the tightest binds, and which one that is depends on the
  // question being asked: a 1-a-day and a 100-a-month limit constrain different
  // things and neither is simply tighter. What a summary can say honestly is
  // that they are still there, because listing only the addition reads as a
  // raise that the others may not allow.
  for (const spend of changed) {
    const others = (merged.spends ?? []).filter((o) => o !== spend && tokenKey(o) === tokenKey(spend));
    for (const other of others) {
      lines.push(
        `  ! note    ${other.allowance} per ${describeSpendPeriod(other.unit, other.multiplier)} on the same token still applies; ` +
          'every limit on a token is charged, so the tightest of them binds'
      );
    }
  }

  return lines;
}
