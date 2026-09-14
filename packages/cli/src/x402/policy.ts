import { USDC_BY_NETWORK, usdcForNetwork } from './asset-registry.js';
import { parseBigInt, parseNonNegativeBigInt } from './amount.js';
import { describePeriod, normalizePeriod, type PeriodUnit } from './period.js';
import { isHexShaped, isPayableAddress, isZeroAddress } from './address.js';
import { UPTO_VERIFIED_CHAIN_IDS, isUptoVerifiedChain } from './permit2.js';
import { isX402Scheme, type X402PaymentRequirement } from './types.js';
import type { GrantedPermission } from '../lib/session-config.js';

/**
 * One spend limit the grant puts on the payment token.
 *
 * A list of these rather than a single allowance and window, because
 * `_checkAndIncrementSpend` charges every limit whose token matches and does
 * not stop at the first. Which one refuses depends on the amount and on the
 * moment, so a single pair cannot answer it, and picking one on the caller's
 * behalf is what reported a month's budget as a day's.
 */
export interface GrantedPeriodLimit {
  /** Base units, decimal string. */
  allowance: string;
  unit: PeriodUnit;
  multiplier: number;
  /** ISO timestamp the windows are anchored at: the permission's own start. */
  anchor: string;
}

/**
 * A limit and what has been drawn against it inside the window containing now.
 *
 * Both meters, because the two caps count different things and always have:
 * the allowance is drawn down by what is pulled through the permission, while
 * a payment is what the payer sends out of the float it already holds.
 */
export interface LimitUsage extends GrantedPeriodLimit {
  /** Payments made from the payer inside this window. */
  spent: bigint;
  /** Pulled through the permission inside this window, which is what the allowance loses. */
  toppedUp: bigint;
  /** When this limit's current window ends. */
  endsAt: Date;
  /**
   * Where `toppedUp` came from. From the ledger it is a floor, since the ledger
   * only sees what went through `payAndFetch`; from the chain it is what the
   * contract will meter against.
   */
  source: 'ledger' | 'chain';
}

/**
 * Tool-level x402 limits (from `~/.jaw/config.json`'s `x402` block). An agent
 * holding a signing key must be fenced in: no single payment above the cap, no
 * cumulative overspend, and only allow-listed assets/networks/recipients. In
 * pull mode these sit alongside the session-EOA's own balance; in push mode the
 * on-chain permission is the hard ceiling and these are the inner guardrails.
 */
export interface X402Policy {
  /** Max base units for a single payment. */
  maxAmountPerPayment?: string;
  /**
   * Max cumulative base units across the whole session. Not a per-process cap:
   * the running total is rebuilt from the payment ledger since the session was
   * created, so it survives restarts. User-configured only, never seeded from
   * the grant (see `perPeriod` for that).
   */
  maxTotalPerSession?: string;
  /**
   * Max base units within one period of the on-chain grant, seeded from it and
   * resetting every period exactly as the permission does. This is the field
   * that mirrors the chain; `maxTotalPerSession` is the user's own ceiling on
   * top. Set together with `period`.
   */
  perPeriod?: GrantedPeriodLimit[];
  /** Allowed asset contract addresses (case-insensitive). Empty/undefined = any. */
  allowedAssets?: string[];
  /** Allowed CAIP-2 networks. Empty/undefined = any. */
  allowedNetworks?: string[];
  /** Allowed resource hostnames. Empty/undefined = any. */
  allowedHosts?: string[];
  /** Allowed `payTo` addresses (case-insensitive). Empty/undefined = any. */
  allowedPayTo?: string[];
  /**
   * Flow 2b: refill target (base units) for the session payer when a top-up
   * runs. Unset = top up exactly the shortfall. Bounded on-chain by the
   * permission either way.
   */
  topUpFloat?: string;
}

/**
 * Conservative caps applied when the user has not configured `x402` limits, so a
 * fresh setup is never unbounded: capped amounts, and only the registry's USDC
 * deployments on their known networks (any other asset a server asks for is
 * refused). USDC has 6 decimals: 1_000_000 = 1 USDC. Override per field via
 * `jaw config set x402.*`.
 */
export const DEFAULT_X402_POLICY: X402Policy = {
  maxAmountPerPayment: '1000000', // 1 USDC per payment
  maxTotalPerSession: '10000000', // 10 USDC per process
  allowedAssets: Object.values(USDC_BY_NETWORK).map((asset) => asset.address),
  allowedNetworks: Object.keys(USDC_BY_NETWORK),
};

/**
 * Two addresses are the same address, compared the way this module gets them:
 * out of a file a person can edit. Space around one keeps a permission's token
 * from matching the registry's, while `isSameToken` in `@jaw.id/core`, which
 * reads the same field for the prefund, goes on matching it.
 *
 * Only the configured side gains that tolerance in `checkPolicy`: an asset or a
 * `payTo` off the wire has already been through `isPayableAddress`, which takes
 * neither space nor a bad checksum.
 */
const eqAddr = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The x402 policy a granted permission implies.
 *
 * Derived on read rather than stored beside the permission. The session used to
 * carry both: the struct, and a `grantedSpend` summary of one USDC limit
 * written at grant time. Two shapes for one fact, at different fidelities, and
 * every consumer had to know which one it was reading. Each of the bugs in this
 * area was a version of the two disagreeing, and the reconciliation between
 * them was itself a source of them. A value that cannot be stored out of date
 * cannot go out of date.
 *
 * Every limit is carried, not reduced to one: the contract charges each of
 * them, so which refuses depends on the amount and the moment, and a single
 * pair cannot answer that.
 *
 * `ceilingFor` in `@jaw.id/core` (`account/spenderPrefund.ts`) reads the same
 * spends under the same rule to size the grant's prefund, reduced to the
 * tightest entry because it needs one number. A change to what the contract
 * charges lands in both.
 *
 * An entry that cannot be read is skipped here rather than taking the whole
 * policy down: the chain still charges that limit, so a pull past it reverts
 * instead of overspending. Core refuses outright on the same input, which is
 * what sizing a transfer calls for.
 */
export function policyFromPermission(permission: GrantedPermission | undefined, chainId: number): X402Policy {
  if (!permission) return {};
  const usdc = Object.values(USDC_BY_NETWORK).find((asset) => asset.chainId === chainId);
  if (!usdc) return {};

  const forToken = permission.spends.filter((spend) => eqAddr(spend.token, usdc.address));
  if (forToken.length === 0) return {};

  // Guarded on the Date, not on the number. `toISOString` throws for a value
  // outside the Date range, and `parseGrantedPermission` only checks that the
  // start is a positive integer: 99999999999999 passes that and is finite, and
  // still raises. The session file is JSON a person can edit, and everything
  // else in this module degrades on bad input rather than taking the command
  // down.
  const start = new Date(permission.start * 1000);
  if (Number.isNaN(start.getTime())) return {};
  const anchor = start.toISOString();
  const perPeriod: GrantedPeriodLimit[] = [];
  for (const spend of forToken) {
    let allowance: string;
    try {
      const parsed = BigInt(spend.allowance);
      // A negative allowance would seed a cap that refuses everything or worse.
      if (parsed < 0n) continue;
      allowance = parsed.toString();
    } catch {
      continue;
    }
    // Normalised the way the SDK normalises before encoding, so a `year` grant
    // lands on the same month-based window the permission actually enforces.
    const period = normalizePeriod(spend.unit, spend.multiplier);
    if (!period) continue;
    perPeriod.push({ allowance, unit: period.unit, multiplier: period.multiplier, anchor });
  }
  if (perPeriod.length === 0) return {};

  return {
    // The registry's canonical address, not the permission's literal string:
    // they match case-insensitively and this seeds an allowlist compared that
    // way.
    allowedAssets: [usdc.address],
    allowedNetworks: [usdc.wireNetwork],
    perPeriod,
  };
}

export function resolveX402Policy(configPolicy?: X402Policy, grantPolicy?: X402Policy): X402Policy {
  const merged: X402Policy = { ...DEFAULT_X402_POLICY, ...(grantPolicy ?? {}), ...(configPolicy ?? {}) };
  // The default session cap is the guardrail for an unconfigured setup that has
  // no grant to bound it. Once a grant supplies a per-period cap, that cap is
  // what the user approved on chain, and leaving the 10-USDC default sitting on
  // top of it would strand a longer grant well short of its own limit: a
  // 5-per-day grant over 7 days permits 35, and the default would stop it at 10.
  // A session cap the user set explicitly still applies on top.
  if (grantPolicy?.perPeriod !== undefined && configPolicy?.maxTotalPerSession === undefined) {
    delete merged.maxTotalPerSession;
  }
  return merged;
}

/**
 * Resolve the policy for a live session. Every front end goes through this, so
 * `jaw x402 pay`, `jaw x402 status` and the MCP tool all enforce and report the
 * same caps. Resolving from config alone is what let them drift: the CLI paid
 * under the 10-USDC defaults on every registry network while the MCP tool
 * refused at the granted per-period allowance, and status printed a session cap
 * that the grant had already deleted.
 */
export function resolveSessionX402Policy(
  configPolicy?: X402Policy,
  session?: { chainId: number; permission?: GrantedPermission } | null
): X402Policy {
  return resolveX402Policy(configPolicy, policyFromPermission(session?.permission, session?.chainId ?? 0));
}

/**
 * Two limits are the same budget when they meter the same window for the same
 * allowance.
 *
 * The allowance is part of it, not decoration. `normalizePeriod` maps a yearly
 * grant onto months, while the merge keys on the raw unit, so `session add` can
 * leave a `year` and a `month` limit that both normalise to the same window.
 * Keyed on the window alone they both resolved to the first usage entry, and
 * the on-chain figures, which are matched by allowance too, were then read off
 * the wrong limit.
 */
export function sameLimit(
  a: { unit: string; multiplier: number; allowance: string },
  b: { unit: string; multiplier: number; allowance: string }
): boolean {
  return a.unit === b.unit && a.multiplier === b.multiplier && a.allowance === b.allowance;
}

/** A limit that may already carry its own usage, as a joined one does. */
type MeteredLimit = GrantedPeriodLimit & { toppedUp?: bigint };

/**
 * What is left of one period limit right now, or null when its allowance cannot
 * be read.
 *
 * Counted against top-ups rather than payments: the allowance mirrors the
 * on-chain one, and what draws it down is the pull through the permission, not
 * what the payer later sends out of the float it already holds. A limit whose
 * usage nobody managed to compute has its whole width left, since a figure
 * nobody read is not a measurement of zero.
 *
 * A limit that already carries `toppedUp` is read off itself. Looking only in
 * `usage`, a caller passing joined limits and no second list would get every
 * limit's full width back, and the ranking would fall through to the allowance.
 */
function remainingOnLimit(limit: MeteredLimit, usage?: LimitUsage[]): bigint | null {
  const cap = parseNonNegativeBigInt(limit.allowance);
  if (cap === undefined) return null;
  const toppedUp = limit.toppedUp ?? (usage ?? []).find((entry) => sameLimit(entry, limit))?.toppedUp ?? 0n;
  return cap > toppedUp ? cap - toppedUp : 0n;
}

/**
 * The limit with the least room left, which is the one that binds now. Sizing a
 * pull and reporting the verdict ask this same question, and answered apart they
 * give different answers to it.
 *
 * Least room, not the smallest allowance: today's counter at zero under a
 * drained month is a session with nothing left, and ranking on the allowance
 * would call it ready right under a printed line reading 100 of 100 used this
 * month.
 *
 * An allowance that cannot be read counts as no room rather than dropping out of
 * the ranking. `checkPolicy` refuses every payment on that input, so ranking it
 * out would report the next limit's healthy figure for a session where nothing
 * can go through.
 */
export function tightestLimit<T extends MeteredLimit>(limits: T[], usage?: LimitUsage[]): T | null {
  let tightest: T | null = null;
  let least: bigint | null = null;
  for (const limit of limits) {
    const left = remainingOnLimit(limit, usage) ?? 0n;
    if (least === null || left < least) {
      tightest = limit;
      least = left;
    }
  }
  return tightest;
}

/**
 * The most a single top-up may move into the payer: the smallest cap that
 * actually binds, never a preferred one. Preferring the per-period cap let a
 * 5-USDC/day grant pre-fund 5 USDC into a session the user had explicitly capped
 * at 1, which is the idle-funds-at-risk case `TopUpOptions.maxTopUp` exists to
 * prevent. Undefined when neither cap is set, meaning the on-chain permission is
 * the only bound.
 *
 * What is left of each cap, not the whole cap: a 10/day grant with 9 already
 * used has 1 to give, and pulling 10 through the permission reverts on chain.
 * With `topUpFloat` set near the cap that revert is a refused payment whose
 * price fit comfortably, so what is already used has to be subtracted here.
 *
 * Each cap is measured against what actually consumes it, which is not the same
 * meter for both. A per-period cap mirrors the on-chain allowance, and what draws
 * that down is the top-up itself, so it counts top-ups. `maxTotalPerSession` is
 * the user's own ceiling on what the session may spend, so it counts payments.
 * Reading the period cap off payments made it lag by whatever float the payer
 * still held, and the pull that overshot was refused on chain.
 */
export function topUpCeiling(
  policy: X402Policy,
  used: { periodUsage?: LimitUsage[]; spentThisSession?: bigint } = {}
): bigint | undefined {
  const left = (cap: string | undefined, alreadyUsed = 0n): bigint | undefined => {
    const parsed = parseNonNegativeBigInt(cap);
    if (parsed === undefined) return undefined;
    return parsed > alreadyUsed ? parsed - alreadyUsed : 0n;
  };
  const caps = [
    // Every limit the policy holds, not every entry the caller built. The
    // contract charges all of them, so a refill sized against any single one
    // can still be refused by another, and a limit that dropped out here would
    // stop bounding the pull at all once a seeded grant deletes the session
    // default.
    ...(policy.perPeriod ?? []).map((limit) => remainingOnLimit(limit, used.periodUsage) ?? 0n),
    left(policy.maxTotalPerSession, used.spentThisSession),
  ].filter((cap): cap is bigint => cap !== undefined);
  return caps.length > 0 ? caps.reduce((a, b) => (a < b ? a : b)) : undefined;
}

/** Policy keys settable from the CLI, split by value shape. */
export const X402_SCALAR_KEYS = ['maxAmountPerPayment', 'maxTotalPerSession', 'topUpFloat'] as const;
export const X402_ARRAY_KEYS = ['allowedAssets', 'allowedNetworks', 'allowedHosts', 'allowedPayTo'] as const;
export type X402PolicyKey = (typeof X402_SCALAR_KEYS)[number] | (typeof X402_ARRAY_KEYS)[number];

export function isX402PolicyKey(key: string): key is X402PolicyKey {
  return (X402_SCALAR_KEYS as readonly string[]).includes(key) || (X402_ARRAY_KEYS as readonly string[]).includes(key);
}

export interface PolicyContext {
  /** Hostname of the resource being paid for (for `allowedHosts`). */
  host?: string;
  /** Base units already spent this session (for `maxTotalPerSession`). */
  spentThisSession?: bigint;
  /**
   * Every limit on the payment token with what has been drawn against it inside
   * the window containing now. Each must be counted over its own window, which
   * resets as that limit does.
   */
  periodUsage?: LimitUsage[];
}

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}

const has = (list: string[] | undefined): list is string[] => Array.isArray(list) && list.length > 0;

/**
 * How much of the user's budget a requirement asks for.
 *
 * Under `exact` that is the price. Under `upto` it is a ceiling the server may
 * charge anything below, and the caps still measure it, because a signature is
 * worth its ceiling to whoever holds it and no cap can be enforced against a
 * number nobody knows yet. Saying so in the refusal is the difference between a
 * user understanding why a five dollar ceiling was refused on a service that
 * charges a fraction of a cent, and thinking the cap is broken.
 *
 * Exported because the caps are not the only thing that refuses over this
 * number: `--max-amount` does too, from the selection loop, and a refusal that
 * spelled it differently there would teach the reader the ceiling is a price.
 */
export const asks = (requirement: X402PaymentRequirement): string =>
  requirement.scheme === 'upto' ? `up to ${requirement.amount}` : requirement.amount;

/**
 * Decide whether a chosen payment requirement is allowed to be paid. Returns the
 * first failing reason so the caller can refuse clearly instead of overpaying.
 */
export function checkPolicy(
  requirement: X402PaymentRequirement,
  policy: X402Policy,
  ctx: PolicyContext = {}
): PolicyResult {
  // The wire value is untrusted: it arrives as a plain string and is only cast
  // to the union, so this is a runtime check and not a redundant one.
  if (!isX402Scheme(requirement.scheme)) {
    return { ok: false, reason: `unsupported scheme: ${String(requirement.scheme)}` };
  }

  // The settlement proxy is deployed on fewer chains than the asset registry
  // knows, and a permit naming a spender with no code can never settle. The
  // check belongs here rather than in the signer: this runs during selection,
  // so an `upto` option on an unverified chain is skipped instead of shadowing
  // a payable `exact` option on the same challenge, a dry run reports the
  // refusal a real run would make, and nothing has been funded yet when it does.
  if (requirement.scheme === 'upto') {
    const asset = usdcForNetwork(requirement.network);
    if (!asset) {
      return { ok: false, reason: `unsupported x402 network: ${requirement.network}` };
    }
    if (!isUptoVerifiedChain(asset.chainId)) {
      return {
        ok: false,
        reason:
          `x402 upto is not available on ${requirement.network}: the settlement proxy is only verified on ` +
          `chain ids ${UPTO_VERIFIED_CHAIN_IDS.join(', ')}`,
      };
    }
    // The witness names the only address the proxy accepts as the settling
    // caller, so a challenge without one can never be paid. The signer refuses
    // it too, but by then the payer has been topped up for a payment that was
    // never going to happen; refused here, the option is skipped during
    // selection like the unverified chain above, and an `exact` option on the
    // same challenge still pays.
    const facilitator = requirement.extra?.['facilitatorAddress'];
    if (!isHexShaped(facilitator) || isZeroAddress(facilitator)) {
      return {
        ok: false,
        reason:
          `x402 upto needs a settling facilitator in extra.facilitatorAddress on ${requirement.network}, ` +
          `got ${JSON.stringify(facilitator)}`,
      };
    }
    // Present and the right shape, but unreadable: a different problem from an
    // absent one, and it sends whoever reads this somewhere else.
    if (!isPayableAddress(facilitator)) {
      return {
        ok: false,
        reason: `extra.facilitatorAddress is not a readable address on ${requirement.network}: ${facilitator}`,
      };
    }
  }

  // Ahead of every allowlist, because these hold whether or not one is
  // configured and because a challenge nobody can act on should say so rather
  // than report whichever allowlist it also happened to miss. Here rather than
  // in a signer so nothing has been funded when they refuse: a settlement that
  // cannot succeed still reserves its whole figure against the caps, on the
  // rule that a failed attempt may have been broadcast. See address.ts.
  for (const [field, value] of [
    ['asset', requirement.asset],
    ['payTo', requirement.payTo],
  ] as const) {
    if (!isPayableAddress(value)) {
      return { ok: false, reason: `${field} is not a readable address on ${requirement.network}: ${value}` };
    }
  }
  if (isZeroAddress(requirement.payTo)) {
    return { ok: false, reason: `payTo is the zero address on ${requirement.network}` };
  }

  if (has(policy.allowedNetworks) && !policy.allowedNetworks.includes(requirement.network)) {
    return { ok: false, reason: `network not allowed: ${requirement.network}` };
  }

  if (has(policy.allowedAssets) && !policy.allowedAssets.some((a) => eqAddr(a, requirement.asset))) {
    return { ok: false, reason: `asset not allowed: ${requirement.asset}` };
  }

  if (has(policy.allowedPayTo) && !policy.allowedPayTo.some((a) => eqAddr(a, requirement.payTo))) {
    return { ok: false, reason: `payTo not allowed: ${requirement.payTo}` };
  }

  if (has(policy.allowedHosts) && (!ctx.host || !policy.allowedHosts.includes(ctx.host))) {
    return { ok: false, reason: `host not allowed: ${ctx.host ?? '(unknown)'}` };
  }

  const amount = parseBigInt(requirement.amount);
  if (amount === null) {
    return { ok: false, reason: `invalid amount: ${requirement.amount}` };
  }
  if (amount < 0n) {
    return { ok: false, reason: `negative amount: ${requirement.amount}` };
  }

  if (policy.maxAmountPerPayment !== undefined) {
    const cap = parseBigInt(policy.maxAmountPerPayment);
    if (cap === null) {
      return { ok: false, reason: `invalid maxAmountPerPayment in config: ${policy.maxAmountPerPayment}` };
    }
    if (amount > cap) {
      return {
        ok: false,
        reason: `amount ${asks(requirement)} exceeds maxAmountPerPayment ${policy.maxAmountPerPayment}`,
      };
    }
  }

  // Checked before the session cap: this is the one that mirrors the on-chain
  // permission, so when both would refuse, the reason the chain would give is
  // the more useful one to report.
  // Driven by the limits the policy holds, with usage looked up per limit and
  // absent usage read as zero. Iterating the caller's list instead made a cap
  // exist only when someone managed to build an entry for it: a limit dropped
  // while computing usage, which happens on an unparseable anchor, silently
  // stopped being enforced, and since a seeded grant deletes the session
  // default there was then nothing bounding a pull at all.
  const exceeded: Array<{ limit: GrantedPeriodLimit; usage?: LimitUsage }> = [];
  for (const limit of policy.perPeriod ?? []) {
    // The rule `remainingOnLimit` ranks by. Read with `parseBigInt`, a negative
    // allowance becomes a negative cap that every amount exceeds, so the refusal
    // names it as a limit that was overrun rather than as a figure nobody can
    // read. The source is not named either: a limit can come off the grant or
    // out of the config file, which is merged over it.
    const cap = parseNonNegativeBigInt(limit.allowance);
    if (cap === undefined) {
      return { ok: false, reason: `invalid spend allowance: ${limit.allowance}` };
    }
    const usage = (ctx.periodUsage ?? []).find((entry) => sameLimit(entry, limit));
    const spent = usage?.spent ?? 0n;
    if (spent + amount > cap) exceeded.push({ limit, usage });
  }
  if (exceeded.length > 0) {
    // The one that frees up last, not the smallest. A refusal is read to decide
    // what to do next, and naming the day limit when the month will refuse
    // again tomorrow sends someone back for nothing. Without a window from the
    // caller the order is undefined, so the first is as good as any.
    const latest = exceeded.reduce((a, b) =>
      (a.usage?.endsAt?.getTime() ?? 0) >= (b.usage?.endsAt?.getTime() ?? 0) ? a : b
    );
    const others = exceeded.length - 1;
    const window = describePeriod(latest.limit.unit, latest.limit.multiplier);
    const resets = latest.usage ? `, which resets ${latest.usage.endsAt.toISOString()}` : '';
    return {
      ok: false,
      reason:
        `payment ${asks(requirement)} would exceed the granted ${latest.limit.allowance} per ${window}${resets}` +
        (others > 0 ? ` (${others} other limit${others === 1 ? '' : 's'} also applies)` : ''),
    };
  }

  if (policy.maxTotalPerSession !== undefined) {
    const cap = parseBigInt(policy.maxTotalPerSession);
    if (cap === null) {
      return { ok: false, reason: `invalid maxTotalPerSession in config: ${policy.maxTotalPerSession}` };
    }
    const spent = ctx.spentThisSession ?? 0n;
    if (spent + amount > cap) {
      return {
        ok: false,
        reason:
          `payment ${asks(requirement)} would exceed maxTotalPerSession ${policy.maxTotalPerSession} ` +
          `(already spent ${spent} since the session was created; raise it with ` +
          `\`jaw config set x402.maxTotalPerSession <base units>\`)`,
      };
    }
  }

  return { ok: true };
}
