import { parseUnits } from 'viem';
import { parseLimit, type LimitPeriod } from './grant-preset.js';
import { describeSpendPeriod, periodLengthSeconds, USDC_BY_NETWORK } from '@jaw.id/agent';
import { formatUsdc } from './status-report.js';
import type { PermissionsConfig } from '../lib/types.js';

/**
 * The most a grant made from this machine may ask for, set by a human.
 *
 * The flow worth having is an agent that hits a 402, asks for a budget, and a
 * human approves it in the browser. It already works, and it works by accident:
 * an agent with shell access runs `jaw session setup --x402 --limit <whatever it
 * likes>`, and the browser screen is the only thing standing between that number
 * and an approval. That makes a grant screen the entire security boundary, and
 * screens get clicked through.
 *
 * A ceiling narrows that for anyone driving the CLI from a terminal. The human
 * names the most they are willing to grant, once; the agent can ask for that or
 * less, and the browser confirms a number that was already bounded. It is the
 * same split the x402 caps already use: the per-period caps and the rest are
 * deliberately unreachable from the MCP tools, because an agent must not raise
 * its own spending caps.
 *
 * It is not the bound the design leans on, and it cannot be, because it assumes
 * a terminal. The case being built for is the MCP added to a chat client as a
 * connector, which asks for a budget, asks again when that runs low, and may
 * have no local machine in the picture at all. A bound has to be enforced and
 * visible where the human actually is, which is the grant screen. Not the bare
 * screen above, which is exactly the one that gets clicked through: one that
 * shows the amount and the period it is being asked to approve. That part is
 * keys-side. Read this as a convenience for terminal users and the screen as
 * the control.
 *
 * Unset means no ceiling, which is what every install has today.
 */

/**
 * Why the grant is more than the ceiling allows, or null when it is not.
 *
 * Two conditions, both conservative in the same direction: the allowance may not
 * exceed the ceiling's, and the period may not be shorter than the ceiling's. A
 * shorter period is more money over the same time even at the same allowance, so
 * `10/hour` is not under a `10/day` ceiling. Together they are stricter than
 * comparing rates, and they can be said in one sentence, which matters for a
 * refusal someone reads while they are trying to get work done.
 *
 * Checked against the resolved permission rather than the `--limit` string, so a
 * hand-written `--permissions` is bounded by the same number. That is the whole
 * point: a bypass an agent can reach is not a ceiling.
 */
export function whyGrantExceedsCeiling(
  permissions: PermissionsConfig,
  chainId: number,
  ceiling: string | undefined
): string | null {
  if (!ceiling) return null;

  let parsed: { amount: string; period: LimitPeriod };
  try {
    parsed = parseLimit(ceiling);
  } catch {
    // A hand-edited ceiling must not become a way past it, and must not take
    // down every setup either. Refuse the grant and say which is which.
    return `The grant ceiling in your config is not a valid limit: ${ceiling}. Fix it with \`jaw config set grantCeiling <amount>/<period>\`, or remove it.`;
  }

  const usdc = Object.values(USDC_BY_NETWORK).find((asset) => asset.chainId === chainId);
  if (!usdc) {
    // The ceiling is an amount of USDC, and this chain has none in the registry
    // to price it against. A permission that spends nothing is still fine; one
    // that spends is refused for the same reason an unpriceable token is, since
    // silently skipping the check on four-fifths of the chains would leave the
    // ceiling true only where someone happened to look.
    return (permissions.spends ?? []).length > 0
      ? `The grant ceiling is set to ${ceiling}, and chain ${chainId} has no USDC in the registry to measure a spend against it. Grant on a supported chain, or remove the ceiling with \`jaw config set grantCeiling ""\`.`
      : null;
  }

  const maxAllowance = parseUnits(parsed.amount, usdc.decimals);
  const ceilingSeconds = periodLengthSeconds(parsed.period, 1, 'max');
  if (ceilingSeconds === null) return null;

  for (const spend of permissions.spends ?? []) {
    if (spend.token.toLowerCase() !== usdc.address.toLowerCase()) {
      // The ceiling is an amount of USDC. A spend on anything else cannot be
      // measured against it, and letting it through unmeasured would be a way
      // around the ceiling rather than an exception to it.
      return `The grant ceiling is set to ${ceiling}, and this permission spends ${spend.token}, which cannot be measured against it. Grant USDC, or remove the ceiling with \`jaw config set grantCeiling ""\`.`;
    }

    let allowance: bigint;
    try {
      allowance = BigInt(spend.allowance);
    } catch {
      return `This permission asks for an allowance that cannot be read: ${spend.allowance}.`;
    }

    if (allowance > maxAllowance) {
      return `This grant asks for ${formatUsdc(allowance.toString(), usdc.decimals)} per period, over the ${ceiling} ceiling set on this machine. Lower it, or raise the ceiling with \`jaw config set grantCeiling <amount>/<period>\`.`;
    }

    const grantSeconds = periodLengthSeconds(spend.unit, spend.multiplier ?? 1, 'min');
    if (grantSeconds === null) {
      return `This permission uses a spend period this CLI does not recognise: ${spend.unit}.`;
    }
    // The same period as the ceiling is never too short, and it has to be said
    // outright: a month is measured at its shortest here and at its longest on
    // the ceiling, so 28 days against 31 refused `10/month` under a `10/month`
    // ceiling. The two tables exist to keep a *different* unit from rounding
    // its way past, and an identical one needs no rounding at all.
    // `parseLimit` gives the ceiling a multiplier of one, so any grant on the
    // same unit runs at least as long as it.
    const sameUnit = spend.unit === parsed.period;
    if (!sameUnit && grantSeconds < ceilingSeconds) {
      return `This grant resets its allowance every ${describeSpendPeriod(spend.unit, spend.multiplier ?? 1)}, which is more often than the ${ceiling} ceiling set on this machine allows. A shorter period is more money over the same time, even at the same allowance.`;
    }
  }

  return null;
}
