/**
 * `checkPolicy` against a restatement of its rules, over generated challenges
 * and policies.
 *
 * An x402 payment is signed by the session key over its own balance, so it
 * never reaches `JustaPermissionManager`. Whatever this function lets through
 * is paid, which makes it the scope check for payments rather than a courtesy
 * in front of one.
 *
 * `allowedByRule` below is written from the policy's documented rules, not from
 * the implementation, and says only yes or no. The reasons are left alone:
 * their order is presentation, and a test that pinned it would be read as the
 * specification.
 */
import fc from 'fast-check';
import { getAddress, isAddress } from 'viem';
import { describe, it, expect } from 'vitest';

import { checkPolicy, type LimitUsage, type PolicyContext, type X402Policy } from './policy.js';
import type { X402PaymentRequirement } from './types.js';

fc.configureGlobal({ seed: 0x402, numRuns: 1000 });

const ZERO = '0x0000000000000000000000000000000000000000';
const POOL = [
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
] as const;
const NETWORKS = ['eip155:8453', 'eip155:84532', 'eip155:1', 'eip155:137'];
const HOSTS = ['api.example.com', 'evil.example.com'];

/** Where `upto` settles, per the proxy deployments. A new chain is a scope change, so it edits this line. */
const UPTO_NETWORKS = ['eip155:8453', 'eip155:84532'];

/**
 * An address as a server or a config might spell it. The all-caps spelling is
 * hex-shaped but fails the checksum, which is the case a readable-address rule
 * exists for.
 */
const spelled = (addresses: readonly string[]) =>
  fc
    .tuple(
      fc.constantFrom(...addresses),
      fc.constantFrom('lower', 'checksum', 'lower', 'checksum', 'lower', 'checksum', 'caps')
    )
    .map(([address, how]) => {
      if (how === 'lower') return address;
      if (how === 'checksum') return getAddress(address);
      return '0x' + address.slice(2).toUpperCase();
    }) as fc.Arbitrary<`0x${string}`>;

const sometimes = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined, freq: 2 });
const small = fc.bigInt({ min: 0n, max: 1_000_000n });

const requirement: fc.Arbitrary<X402PaymentRequirement> = fc.record({
  scheme: fc.constantFrom('exact', 'exact', 'exact', 'upto', 'bogus') as fc.Arbitrary<X402PaymentRequirement['scheme']>,
  network: fc.constantFrom(...NETWORKS),
  amount: small.map(String),
  asset: spelled(POOL),
  payTo: spelled([...POOL, ZERO]),
  extra: fc.option(fc.record({ facilitatorAddress: spelled([...POOL, ZERO]) }), { nil: undefined }),
});

/**
 * Policies are built around the requirement: a list that usually holds the value and a cap that lands on either side of the price. Drawn
 * independently, almost every case is refused on the first rule it meets and
 * the later rules are never reached.
 */
const listAround = <T>(value: T, others: fc.Arbitrary<T>) =>
  sometimes(
    fc
      .tuple(fc.array(others, { maxLength: 2 }), fc.constantFrom(true, true, true, false))
      .map(([rest, include]) => (include ? [...rest, value] : rest))
  );
const capAround = (price: bigint) =>
  sometimes(fc.bigInt({ min: -100_000n, max: 500_000n }).map((d) => String(price + d < 0n ? 0n : price + d)));

function scenarioFor(req: X402PaymentRequirement) {
  const price = BigInt(req.amount);
  const periodLimit = fc.record({
    allowance: capAround(price).map((a) => a ?? '0'),
    unit: fc.constantFrom('day', 'month') as fc.Arbitrary<'day' | 'month'>,
    multiplier: fc.integer({ min: 1, max: 3 }),
    anchor: fc.constant('2026-01-01T00:00:00.000Z'),
  });
  const policy: fc.Arbitrary<X402Policy> = fc.record({
    maxAmountPerPayment: capAround(price),
    maxTotalPerSession: capAround(price),
    perPeriod: fc.array(periodLimit, { maxLength: 2 }),
    allowedAssets: listAround(req.asset as string, spelled(POOL)),
    allowedNetworks: listAround(req.network, fc.constantFrom(...NETWORKS)),
    allowedHosts: listAround('api.example.com', fc.constantFrom(...HOSTS)),
    allowedPayTo: listAround(req.payTo as string, spelled(POOL)),
  });
  const spent = sometimes(fc.bigInt({ min: 0n, max: 200_000n }));
  return policy.chain((p) => {
    const usages = fc.tuple(...(p.perPeriod ?? []).map(() => spent));
    const ctx: fc.Arbitrary<PolicyContext> = fc.record({
      host: fc.constantFrom<string | undefined>(
        'api.example.com',
        'api.example.com',
        'api.example.com',
        'evil.example.com',
        undefined
      ),
      spentThisSession: spent,
      // Usage for some of the limits, so an absent entry is exercised too.
      periodUsage: usages.map((drawn) =>
        (p.perPeriod ?? []).flatMap((limit, i): LimitUsage[] => {
          const used = drawn[i];
          if (used === undefined) return [];
          return [{ ...limit, spent: used, toppedUp: 0n, endsAt: new Date('2026-01-02'), source: 'ledger' }];
        })
      ),
    });
    return fc.tuple(fc.constant(req), fc.constant(p), ctx);
  });
}

const scenario = requirement.chain(scenarioFor);

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isNonZeroAddress = (value: unknown): value is string =>
  typeof value === 'string' && isAddress(value) && BigInt(value) !== 0n;

function allowedByRule(req: X402PaymentRequirement, p: X402Policy, ctx: PolicyContext): boolean {
  if (req.scheme !== 'exact' && req.scheme !== 'upto') return false;
  if (req.scheme === 'upto') {
    if (!UPTO_NETWORKS.includes(req.network)) return false;
    if (!isNonZeroAddress(req.extra?.['facilitatorAddress'])) return false;
  }
  if (!isAddress(req.asset) || !isNonZeroAddress(req.payTo)) return false;

  const listed = (list: string[] | undefined, value: string | undefined, eq: (a: string, b: string) => boolean) =>
    !list?.length || (value !== undefined && list.some((entry) => eq(entry, value)));
  const exact = (a: string, b: string) => a === b;
  if (!listed(p.allowedNetworks, req.network, exact)) return false;
  if (!listed(p.allowedAssets, req.asset, sameAddress)) return false;
  if (!listed(p.allowedPayTo, req.payTo, sameAddress)) return false;
  if (!listed(p.allowedHosts, ctx.host, exact)) return false;

  const price = BigInt(req.amount);
  if (p.maxAmountPerPayment !== undefined && price > BigInt(p.maxAmountPerPayment)) return false;
  for (const limit of p.perPeriod ?? []) {
    const usage = ctx.periodUsage?.find(
      (u) => u.unit === limit.unit && u.multiplier === limit.multiplier && u.allowance === limit.allowance
    );
    if ((usage?.spent ?? 0n) + price > BigInt(limit.allowance)) return false;
  }
  if (p.maxTotalPerSession !== undefined && (ctx.spentThisSession ?? 0n) + price > BigInt(p.maxTotalPerSession)) {
    return false;
  }
  return true;
}

describe('what a session may pay', () => {
  it('pays exactly what the rules allow, and nothing else', () => {
    fc.assert(
      fc.property(scenario, ([req, p, ctx]) => {
        expect(checkPolicy(req, p, ctx).ok).toBe(allowedByRule(req, p, ctx));
      })
    );
  });

  it('reaches both answers often enough to mean something', () => {
    // Guards the generator: a scenario that refuses nearly everything would
    // pass the property above without testing any of the later rules.
    const allowed = fc.sample(scenario, 1000).filter(([req, p, ctx]) => allowedByRule(req, p, ctx)).length;
    expect(allowed).toBeGreaterThan(50);
    expect(allowed).toBeLessThan(950);
  });

  it('always says why when it refuses', () => {
    fc.assert(
      fc.property(scenario, ([req, p, ctx]) => {
        const verdict = checkPolicy(req, p, ctx);
        if (!verdict.ok) expect(verdict.reason).toMatch(/\S/);
      })
    );
  });
});
