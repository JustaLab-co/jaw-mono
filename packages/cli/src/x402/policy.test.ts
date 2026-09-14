import { describe, it, expect } from 'vitest';

/** The limit as the policy holds it: the cap exists here, not in the usage. */
function limit(allowance: string, unit = 'day') {
  return { allowance, unit: unit as 'day' | 'month', multiplier: 1, anchor: '2026-01-01T00:00:00.000Z' };
}

/** A limit with its usage, as the payment paths now hand it to the policy. */
function usage(allowance: string, toppedUp = 0n, unit = 'day', endsAt = new Date('2026-01-02T00:00:00.000Z')) {
  return {
    allowance,
    unit: unit as 'day' | 'month',
    multiplier: 1,
    anchor: '2026-01-01T00:00:00.000Z',
    spent: 0n,
    toppedUp,
    endsAt,
    source: 'ledger' as const,
  };
}

const BASE = 8453;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * A granted permission, which is now the only place a policy is derived from.
 * The session used to also carry a `grantedSpend` summary of one limit, and the
 * two could describe different budgets; deriving on read removes the question.
 */
function permissionWith(spends: Array<{ allowance: string; unit: string; multiplier?: number; token?: string }>) {
  return {
    account: '0x1111111111111111111111111111111111111111',
    spender: '0x2222222222222222222222222222222222222222',
    start: Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000),
    end: Math.floor(new Date('2026-02-01T00:00:00.000Z').getTime() / 1000),
    salt: '0xabc',
    calls: [{ target: BASE_USDC, selector: '0xa9059cbb' }],
    spends: spends.map((s) => ({
      token: s.token ?? BASE_USDC,
      allowance: s.allowance,
      unit: s.unit,
      multiplier: s.multiplier ?? 1,
    })),
  };
}

import {
  checkPolicy,
  resolveX402Policy,
  policyFromPermission,
  DEFAULT_X402_POLICY,
  isX402PolicyKey,
  X402_SCALAR_KEYS,
  resolveSessionX402Policy,
  topUpCeiling,
  tightestLimit,
} from './policy.js';
import { USDC_BY_NETWORK } from './asset-registry.js';
import type { X402PaymentRequirement } from './types.js';

const base: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  maxTimeoutSeconds: 60,
};

// What a payable upto option carries on top of `base`: the witness must name
// the settling caller, and checkPolicy skips the option without one.
const uptoExtra = { extra: { facilitatorAddress: '0x1111111111111111111111111111111111111111' } };

describe('checkPolicy', () => {
  it('allows a payment under an empty policy', () => {
    expect(checkPolicy(base, {})).toEqual({ ok: true });
  });

  it('allows the two schemes this client can produce a payment for', () => {
    expect(checkPolicy(base, {}).ok).toBe(true);
    expect(checkPolicy({ ...base, scheme: 'upto', ...uptoExtra }, {}).ok).toBe(true);
  });

  it('rejects a scheme it cannot sign', () => {
    // Off the wire the scheme is a plain string, so this is a runtime check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(checkPolicy({ ...base, scheme: 'permit2-batch' as any }, {}).ok).toBe(false);
  });

  /**
   * Under `upto` the number the caps measure is a ceiling, not a price, and a
   * refusal that read like a price would look broken to anyone paying a service
   * that charges a fraction of it.
   */
  it('names the ceiling as a ceiling when it refuses one', () => {
    const verdict = checkPolicy(
      { ...base, scheme: 'upto', amount: '5000000', ...uptoExtra },
      { maxAmountPerPayment: '1000000' }
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('up to 5000000');
  });

  /**
   * The settlement proxy is only deployed on two of the four chains the asset
   * registry carries, and the check used to live in the signer, downstream of
   * the top-up. Refusing here means the option is skipped during selection: a
   * dry run tells the truth, and nothing has been spent when it does.
   */
  it('refuses an upto option on a chain the settlement proxy was never verified on', () => {
    const polygon = {
      ...base,
      scheme: 'upto' as const,
      network: 'eip155:137',
      asset: USDC_BY_NETWORK['eip155:137'].address,
    };
    const verdict = checkPolicy(polygon, {});
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('is not available on eip155:137');
    // The same challenge under `exact` still pays: the refusal is about where
    // the proxy exists, not about the chain.
    expect(checkPolicy({ ...polygon, scheme: 'exact' }, {}).ok).toBe(true);
  });

  /**
   * Same shape as the chain check above, and for the same money: the signer
   * refuses a challenge without a facilitator too, but only after the funder
   * has topped the payer up for it. Refused during selection, nothing has been
   * spent and a dry run tells the truth.
   */
  it('refuses an upto option that names no facilitator to settle it', () => {
    const verdict = checkPolicy({ ...base, scheme: 'upto' }, {});
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('facilitatorAddress');

    const malformed = checkPolicy({ ...base, scheme: 'upto', extra: { facilitatorAddress: 'not-an-address' } }, {});
    expect(malformed.ok).toBe(false);
    expect(malformed.reason).toContain('facilitatorAddress');

    // The same challenge under exact still pays: EIP-3009 has no facilitator
    // witness to bind.
    expect(checkPolicy(base, {}).ok).toBe(true);
  });

  /**
   * A mixed-case address that fails EIP-55 is one viem and every other client
   * downstream refuses, and `accepted` echoes the requirement byte for byte, so
   * re-casing the payload would leave the document disagreeing with itself.
   * Refused here, during selection, where it costs nothing.
   */
  it('refuses an address no counterparty could read', () => {
    const shouty = (a: string) => a.toUpperCase().replace('0X', '0x');

    for (const field of ['asset', 'payTo'] as const) {
      const verdict = checkPolicy({ ...base, [field]: shouty(base[field]) as `0x${string}` }, {});
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain(`${field} is not a readable address`);
    }

    // Reported as unreadable rather than as whichever allowlist it also missed,
    // which is why the check sits ahead of them.
    const withAllowlist = checkPolicy(
      { ...base, asset: shouty(base.asset) as `0x${string}` },
      {
        allowedAssets: [base.asset],
      }
    );
    expect(withAllowlist.reason).toContain('asset is not a readable address');

    // An unreadable facilitator is not an absent one, and does not say it is.
    const badFacilitator = checkPolicy(
      { ...base, scheme: 'upto', extra: { facilitatorAddress: shouty(base.payTo) } },
      {}
    );
    expect(badFacilitator.reason).toContain('facilitatorAddress is not a readable address');

    // Both spellings a real server uses are payable.
    for (const spell of [(a: string) => a, (a: string) => a.toLowerCase()]) {
      expect(checkPolicy({ ...base, payTo: spell(base.payTo) as `0x${string}` }, {}).ok).toBe(true);
    }
  });

  /**
   * address(0) has the shape and none of the meaning. The proxy reverts for
   * every caller when the witness names it, so the permit can never settle, and
   * a payment to it is destroyed. Both would be funded first and then counted
   * in full against the caps.
   */
  it('refuses the zero address as a facilitator or a recipient', () => {
    const zero = `0x${'0'.repeat(40)}`;

    const asFacilitator = checkPolicy({ ...base, scheme: 'upto', extra: { facilitatorAddress: zero } }, {});
    expect(asFacilitator.ok).toBe(false);
    expect(asFacilitator.reason).toContain('facilitatorAddress');

    // Both schemes, and with no allowlist configured.
    for (const scheme of ['exact', 'upto'] as const) {
      const verdict = checkPolicy({ ...base, scheme, ...uptoExtra, payTo: zero as `0x${string}` }, {});
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('zero address');
    }
  });

  it('enforces maxAmountPerPayment', () => {
    expect(checkPolicy(base, { maxAmountPerPayment: '999' }).ok).toBe(false);
    expect(checkPolicy(base, { maxAmountPerPayment: '1000' }).ok).toBe(true);
  });

  it('enforces maxTotalPerSession against prior spend', () => {
    expect(checkPolicy(base, { maxTotalPerSession: '1500' }, { spentThisSession: 600n }).ok).toBe(false);
    expect(checkPolicy(base, { maxTotalPerSession: '1500' }, { spentThisSession: 500n }).ok).toBe(true);
  });

  it('enforces allowedNetworks', () => {
    expect(checkPolicy(base, { allowedNetworks: ['eip155:84532'] }).ok).toBe(false);
    expect(checkPolicy(base, { allowedNetworks: ['eip155:8453'] }).ok).toBe(true);
  });

  it('enforces allowedAssets case-insensitively', () => {
    expect(checkPolicy(base, { allowedAssets: [base.asset.toLowerCase()] }).ok).toBe(true);
    expect(checkPolicy(base, { allowedAssets: ['0x0000000000000000000000000000000000000bad'] }).ok).toBe(false);
  });

  it('enforces allowedPayTo case-insensitively', () => {
    expect(checkPolicy(base, { allowedPayTo: [base.payTo.toLowerCase()] }).ok).toBe(true);
    expect(checkPolicy(base, { allowedPayTo: ['0x0000000000000000000000000000000000000000'] }).ok).toBe(false);
  });

  it('enforces allowedHosts against the context host', () => {
    expect(checkPolicy(base, { allowedHosts: ['api.example.com'] }, { host: 'evil.com' }).ok).toBe(false);
    expect(checkPolicy(base, { allowedHosts: ['api.example.com'] }, { host: 'api.example.com' }).ok).toBe(true);
    expect(checkPolicy(base, { allowedHosts: ['api.example.com'] }, {}).ok).toBe(false);
  });

  it('rejects an invalid or negative amount', () => {
    expect(checkPolicy({ ...base, amount: 'abc' }, {}).ok).toBe(false);
    expect(checkPolicy({ ...base, amount: '-1' }, {}).ok).toBe(false);
  });

  it('refuses cleanly (no throw) on a malformed policy cap', () => {
    expect(checkPolicy(base, { maxAmountPerPayment: 'not-a-number' })).toEqual({
      ok: false,
      reason: expect.stringContaining('invalid maxAmountPerPayment'),
    });
    expect(checkPolicy(base, { maxTotalPerSession: 'oops' }).ok).toBe(false);
  });
});

describe('resolveX402Policy', () => {
  it('applies conservative defaults when nothing is configured', () => {
    expect(resolveX402Policy()).toEqual(DEFAULT_X402_POLICY);
    expect(resolveX402Policy().maxAmountPerPayment).toBe('1000000'); // 1 USDC
  });

  it('lets config override a default per field', () => {
    const policy = resolveX402Policy({ maxAmountPerPayment: '50' });
    expect(policy.maxAmountPerPayment).toBe('50');
    expect(policy.maxTotalPerSession).toBe(DEFAULT_X402_POLICY.maxTotalPerSession);
  });

  it('defaults restrict assets and networks to the USDC registry', () => {
    const policy = resolveX402Policy();
    expect(policy.allowedNetworks).toContain('eip155:8453');
    expect(policy.allowedAssets).toContain('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    // An unconfigured setup pays the known USDC but refuses any other token a
    // server may ask for, even on an allowed network.
    expect(checkPolicy(base, policy).ok).toBe(true);
    expect(checkPolicy({ ...base, asset: '0x0000000000000000000000000000000000000bad' }, policy).ok).toBe(false);
    expect(checkPolicy({ ...base, network: 'eip155:1' }, policy).ok).toBe(false);
  });
});

describe('policyFromPermission', () => {
  it('returns an empty policy when the session carries no permission', () => {
    expect(policyFromPermission(undefined, BASE)).toEqual({});
  });

  it('seeds the per-period cap, the allowlists and the anchor from the permission', () => {
    expect(policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'day' }]), BASE)).toEqual({
      allowedAssets: [BASE_USDC],
      allowedNetworks: ['eip155:8453'],
      perPeriod: [{ allowance: '5000000', unit: 'day', multiplier: 1, anchor: '2026-01-01T00:00:00.000Z' }],
    });
  });

  /**
   * The contract charges every limit matching a token, so the policy carries
   * all of them. Reducing to one meant answering "what refuses this payment"
   * and "what runs out first" with the same number, and they come apart.
   */
  it('carries every limit the permission puts on the token', () => {
    const policy = policyFromPermission(
      permissionWith([
        { allowance: '100000000', unit: 'month' },
        { allowance: '1000000', unit: 'day' },
      ]),
      BASE
    );
    expect(policy.perPeriod?.map((l) => [l.allowance, l.unit])).toEqual([
      ['100000000', 'month'],
      ['1000000', 'day'],
    ]);
  });

  // The SDK rewrites `year` to months before encoding, so the local window has
  // to land where the permission actually enforces it.
  it('normalises a yearly grant to the months the contract stores', () => {
    const policy = policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'year', multiplier: 2 }]), BASE);
    expect(policy.perPeriod?.[0]).toMatchObject({ unit: 'month', multiplier: 24 });
  });

  it('ignores a spend in a token the chain has no registry entry for', () => {
    const other = '0x9999999999999999999999999999999999999999';
    expect(policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'day', token: other }]), BASE)).toEqual(
      {}
    );
  });

  /**
   * The permission reaches here off `loadSessionConfig`, which parses the file
   * and casts: `parseGrantedPermission` runs when a session is written, not when
   * one is read. So a hand-edited token carries whatever space someone left, and
   * dropping the entry over it deletes the grant's cap and drops the session
   * back to the defaults. `isSameToken` in `@jaw.id/core` reads the same field
   * the same way for the prefund.
   */
  it('matches a token the session file left space around', () => {
    const policy = policyFromPermission(
      permissionWith([{ allowance: '5000000', unit: 'day', token: ` ${BASE_USDC} ` }]),
      BASE
    );
    expect(policy.perPeriod).toEqual([
      { allowance: '5000000', unit: 'day', multiplier: 1, anchor: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('returns an empty policy on a chain with no registry USDC', () => {
    expect(policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'day' }]), 1)).toEqual({});
  });
});

describe('resolveX402Policy — grant layer', () => {
  const seeded = () => policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'day' }]), BASE);

  it('seeds the per-period cap and allowlists, keeping the default per-payment cap', () => {
    const policy = resolveX402Policy(undefined, seeded());
    expect(policy.perPeriod?.[0].allowance).toBe('5000000');
    expect(policy.allowedNetworks).toEqual(['eip155:8453']);
    expect(policy.maxAmountPerPayment).toBe(DEFAULT_X402_POLICY.maxAmountPerPayment);
  });

  it('leaves config untouched when there is no permission', () => {
    const policy = resolveX402Policy({ maxTotalPerSession: '50000000' });
    expect(policy.maxTotalPerSession).toBe('50000000');
  });

  // The session cap used to be pinned to the grant. That clamp only existed
  // because a per-period allowance was written into a session-wide field, and
  // it silently rewrote whatever the user configured.
  it('does not rewrite a config session cap from the per-period allowance', () => {
    const policy = resolveX402Policy({ maxTotalPerSession: '50000000' }, seeded());
    expect(policy.maxTotalPerSession).toBe('50000000');
    expect(policy.perPeriod?.[0].allowance).toBe('5000000');
  });
});

describe('resolveSessionX402Policy', () => {
  const session = { chainId: BASE, permission: permissionWith([{ allowance: '5000000', unit: 'day' }]) };

  // The regression this exists to stop: `jaw x402 pay` and `jaw x402 status`
  // resolved from config alone, so they ran on the 10-USDC defaults across every
  // registry network while the MCP tool refused at the granted per-period cap.
  it('seeds from the session grant, matching what the MCP path enforces', () => {
    const policy = resolveSessionX402Policy(undefined, session);
    expect(policy.perPeriod?.[0].allowance).toBe('5000000');
    expect(policy.allowedNetworks).toEqual(['eip155:8453']);
    expect(policy.maxTotalPerSession).toBeUndefined(); // the 10-USDC default gives way to the grant
  });

  it('falls back to config-only resolution when the session has no grant', () => {
    expect(resolveSessionX402Policy(undefined, undefined)).toEqual(DEFAULT_X402_POLICY);
    expect(resolveSessionX402Policy(undefined, { chainId: BASE })).toEqual(DEFAULT_X402_POLICY);
  });
});

describe('topUpCeiling', () => {
  // Preferring the per-period cap pre-funded the payer with more than the session
  // could ever spend: a 5-USDC/day grant against an explicit 1-USDC session cap
  // moved 5 USDC into the payer for a session that stops at 1.
  it('takes the smaller cap, not the per-period one', () => {
    expect(
      topUpCeiling(
        { maxTotalPerSession: '1000000', perPeriod: [limit('5000000')] },
        { periodUsage: [usage('5000000')] }
      )
    ).toBe(1000000n);
  });

  it('takes the per-period cap when it is the smaller one', () => {
    expect(
      topUpCeiling(
        { maxTotalPerSession: '5000000', perPeriod: [limit('1000000')] },
        { periodUsage: [usage('1000000')] }
      )
    ).toBe(1000000n);
  });

  it('uses whichever cap is set on its own', () => {
    expect(topUpCeiling({ perPeriod: [limit('5000000')] }, { periodUsage: [usage('5000000')] })).toBe(5000000n);
    expect(topUpCeiling({ maxTotalPerSession: '3000000' })).toBe(3000000n);
  });

  it('is unbounded when neither cap is set, leaving the permission as the only bound', () => {
    expect(topUpCeiling({})).toBeUndefined();
  });

  // Pulling the whole cap through a permission that has 1 USDC of allowance left
  // reverts on-chain, refusing a payment whose price fit comfortably.
  it('bounds by what is left of each cap, not its full width', () => {
    expect(topUpCeiling({ perPeriod: [limit('10000000')] }, { periodUsage: [usage('10000000', 9000000n)] })).toBe(
      1000000n
    );
    expect(topUpCeiling({ maxTotalPerSession: '10000000' }, { spentThisSession: 4000000n })).toBe(6000000n);
  });

  // The on-chain allowance is drawn down by the pull, the session ceiling by the
  // payment; with a float those two numbers differ by what the payer still holds.
  it('measures the period cap by top-ups and the session cap by payments', () => {
    expect(
      topUpCeiling(
        { maxTotalPerSession: '20000000', perPeriod: [limit('10000000')] },
        { periodUsage: [usage('10000000', 5800000n)], spentThisSession: 5300000n }
      )
    ).toBe(4200000n); // the permission's real remainder, not the 4.7 payments suggest
  });

  it('takes whichever of the two is tighter', () => {
    expect(
      topUpCeiling(
        { maxTotalPerSession: '20000000', perPeriod: [limit('10000000')] },
        { periodUsage: [usage('10000000', 2000000n)], spentThisSession: 19000000n }
      )
    ).toBe(1000000n);
  });

  it('floors an exhausted cap at zero rather than going negative', () => {
    expect(topUpCeiling({ perPeriod: [limit('1000000')] }, { periodUsage: [usage('1000000', 5000000n)] })).toBe(0n);
  });

  // Hand-edited config must not bound the top-up by a garbage number.
  /**
   * A cap that cannot be read bounds at zero rather than dropping out.
   * `checkPolicy` refuses outright on the same input, and letting it vanish
   * here was the fail-open shape this file exists to keep closed: with the
   * session default deleted by a seeded grant, nothing local would bound the
   * pull at all.
   */
  it('bounds at zero for an unreadable or negative cap rather than ignoring it', () => {
    expect(topUpCeiling({ perPeriod: [limit('abc')], maxTotalPerSession: '2000000' })).toBe(0n);
    expect(topUpCeiling({ perPeriod: [limit('-1')], maxTotalPerSession: '2000000' })).toBe(0n);
    expect(topUpCeiling({ perPeriod: [limit('abc')] })).toBe(0n);
  });
});

describe('tightestLimit', () => {
  /**
   * Sizing a top-up and reporting the verdict ask the same question. Answered
   * apart, `jaw x402 status` says ready for a session whose month is drained,
   * because today's counter is still at zero.
   */
  it('takes the limit with the least room left, not the smallest allowance', () => {
    const day = limit('1000000');
    const month = limit('100000000', 'month');
    expect(tightestLimit([day, month], [usage('100000000', 99_500_000n, 'month')])).toBe(month);
  });

  /**
   * `checkPolicy` refuses every payment on an allowance it cannot read, so a
   * limit ranked out of this would report the next one's healthy figure for a
   * session where nothing can go through.
   */
  it('counts an unreadable allowance as no room rather than dropping it', () => {
    const unreadable = limit('abc');
    expect(tightestLimit([limit('1000000'), unreadable])).toBe(unreadable);
  });

  it('has nothing to report when the policy holds no limit', () => {
    expect(tightestLimit([])).toBeNull();
  });

  /**
   * `jaw x402 status` joins usage onto its limits before ranking them, so the
   * limits it passes already carry `toppedUp`. Read only out of the second
   * argument, a caller with nothing to pass there would get every limit's full
   * width back, and the ranking would fall through to the smallest allowance.
   */
  it('reads the usage a joined limit already carries', () => {
    const day = usage('1000000');
    const month = usage('100000000', 99_500_000n, 'month');
    expect(tightestLimit([day, month])).toBe(month);
  });
});

describe('topUpFloat as a settable policy key', () => {
  it('Given topUpFloat, When validated as a config key, Then it is accepted as a scalar', () => {
    expect(isX402PolicyKey('topUpFloat')).toBe(true);
    expect((X402_SCALAR_KEYS as readonly string[]).includes('topUpFloat')).toBe(true);
  });
});

describe('per-period cap', () => {
  // Seeded from a permission, so the 10-USDC session default gives way to the
  // grant, the way it does for a real session.
  const policy = resolveX402Policy(
    undefined,
    policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'day' }]), BASE)
  );
  // The per-payment default is 1 USDC, which would refuse before any limit does.
  const roomy = { ...policy, maxAmountPerPayment: '100000000' };
  const limits = (toppedUp: bigint, spent: bigint) => [{ ...usage('5000000', toppedUp), spent }];
  const oneUsdc = { ...base, amount: '1000000' };

  it('allows spending up to the period allowance', () => {
    expect(checkPolicy(oneUsdc, policy, { periodUsage: limits(0n, 4000000n) })).toEqual({ ok: true });
  });

  it('refuses once the period allowance is used up', () => {
    const result = checkPolicy(oneUsdc, policy, { periodUsage: limits(0n, 5000000n) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('per day');
  });

  // The blocker this design resolves: a 5 USDC/day grant with a 7-day expiry
  // permits 35 USDC on chain. Seeding the session-wide cap from one period's
  // allowance stranded the session at 5 USDC for all 7 days, with the clamp
  // silently undoing any config attempt to raise it.
  it('does not strand a multi-period grant after the first period', () => {
    // Day 3, having already spent 5 USDC on each of days 1 and 2.
    const spentAcrossSession = 10000000n;
    const result = checkPolicy(oneUsdc, policy, { spentThisSession: spentAcrossSession, periodUsage: limits(0n, 0n) });
    expect(result).toEqual({ ok: true });
  });

  it('names the window and when it resets, so the refusal is diagnosable', () => {
    const result = checkPolicy(oneUsdc, policy, {
      periodUsage: [{ ...usage('5000000', 0n, 'day', new Date('2026-01-04T00:00:00.000Z')), spent: 5000000n }],
    });
    expect(result.reason).toContain('2026-01-04T00:00:00.000Z');
    expect(result.reason).toContain('per day');
  });

  /**
   * The case this whole change exists for. A session holding 50 a day and 100 a
   * month, 60 already drawn this month: the day limit has room and the month
   * does not, and the refusal has to name the month, because being told to wait
   * until tomorrow sends someone back into the same refusal.
   */
  it('refuses on the limit that frees up last, not the smallest', () => {
    const twoUsdc = { ...base, amount: '2000000' };
    const both = { ...roomy, perPeriod: [limit('50000000'), limit('100000000', 'month')] };
    const result = checkPolicy(twoUsdc, both, {
      periodUsage: [
        { ...usage('50000000', 0n, 'day', new Date('2026-01-02T00:00:00.000Z')), spent: 0n },
        { ...usage('100000000', 0n, 'month', new Date('2026-02-01T00:00:00.000Z')), spent: 99000000n },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('per month');
    expect(result.reason).toContain('2026-02-01T00:00:00.000Z');
  });

  it('counts the others when more than one would refuse', () => {
    const twoUsdc = { ...base, amount: '2000000' };
    const both = { ...roomy, perPeriod: [limit('50000000'), limit('100000000', 'month')] };
    const result = checkPolicy(twoUsdc, both, {
      periodUsage: [
        { ...usage('50000000', 0n, 'day', new Date('2026-01-02T00:00:00.000Z')), spent: 49000000n },
        { ...usage('100000000', 0n, 'month', new Date('2026-02-01T00:00:00.000Z')), spent: 99000000n },
      ],
    });
    expect(result.reason).toContain('per month');
    expect(result.reason).toContain('1 other limit also applies');
  });

  it('still enforces a session ceiling the user configured on top', () => {
    const withCeiling = resolveX402Policy(
      { maxTotalPerSession: '8000000' },
      policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'day' }]), BASE)
    );
    const result = checkPolicy(oneUsdc, withCeiling, { spentThisSession: 8000000n, periodUsage: limits(0n, 0n) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('maxTotalPerSession');
  });

  it('reports the granted period cap ahead of the session cap when both would refuse', () => {
    const withCeiling = resolveX402Policy(
      { maxTotalPerSession: '8000000' },
      policyFromPermission(permissionWith([{ allowance: '5000000', unit: 'day' }]), BASE)
    );
    const result = checkPolicy(oneUsdc, withCeiling, { spentThisSession: 8000000n, periodUsage: limits(0n, 5000000n) });
    expect(result.reason).toContain('per day');
  });

  /**
   * The cap lives in the policy, so a limit whose usage could not be computed
   * still bounds. Driving the check from the caller's list instead meant an
   * entry dropped while building usage silently removed the cap, and with the
   * session default deleted by a seeded grant there was then nothing bounding
   * a pull at all.
   */
  it('still refuses when the usage for a limit could not be built', () => {
    const result = checkPolicy(oneUsdc, { ...policy, perPeriod: [limit('500000')] }, { periodUsage: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('per day');
  });

  it('still bounds a top-up when the usage for a limit could not be built', () => {
    expect(topUpCeiling({ perPeriod: [limit('500000')] }, { periodUsage: [] })).toBe(500000n);
  });

  it('refuses rather than passing an allowance it cannot read', () => {
    const result = checkPolicy(oneUsdc, { ...policy, perPeriod: [limit('abc')] }, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('invalid spend allowance');
  });

  /**
   * A negative allowance is unreadable, not a limit that was overrun. Read with
   * `parseBigInt` it becomes a negative cap, every amount exceeds it, and the
   * refusal quotes it as if it were the figure the user granted.
   */
  it('names a negative allowance as unreadable rather than as an overrun limit', () => {
    const result = checkPolicy(oneUsdc, { ...policy, perPeriod: [limit('-5000000')] }, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('invalid spend allowance');
    expect(result.reason).not.toContain('would exceed');
  });

  /**
   * `parseGrantedPermission` only checks that the start is a positive integer,
   * and a positive integer can still be outside the Date range: 99999999999999
   * passes that check, is finite, and makes `toISOString` raise. Guarding the
   * number rather than the Date left the crash the guard was added for.
   */
  it('returns an empty policy for a start no Date can represent', () => {
    const wild = { ...permissionWith([{ allowance: '5000000', unit: 'day' }]), start: 99999999999999 };
    expect(() => policyFromPermission(wild, BASE)).not.toThrow();
    expect(policyFromPermission(wild, BASE)).toEqual({});
  });
});
