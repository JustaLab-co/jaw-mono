/**
 * What reaches the signer out of a hostile 402 challenge.
 *
 * The server writes the whole `accepts` list, so it is generated here: shapes
 * the wire schema must reject mixed with well-formed options the caller's
 * constraints and the policy may or may not allow. The payer and the funding
 * hook are traps that record what they were handed, and the payer throws so
 * nothing past the signature runs.
 *
 * Eligibility reuses `checkPolicy`, which `policy.property.test.ts` holds to its
 * own restated rules. What is under test here is the selection around it: at
 * most one option is funded and signed, it is an eligible one, and it is the
 * cheapest, with a tie going to `exact`.
 */
import fc from 'fast-check';
import { getAddress } from 'viem';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { payAndFetch, type PayAndFetchOptions } from './http.js';
import { checkPolicy, type X402Policy } from './policy.js';
import type { Payer } from './payer.js';
import type { X402PaymentRequirement } from './types.js';

fc.configureGlobal({ seed: 0x1402, numRuns: 300 });

const URL_UNDER_TEST = 'https://api.example.com/paid';
const POOL = [
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
];

const address = fc
  .tuple(fc.constantFrom(...POOL), fc.boolean())
  .map(([a, checksum]) => (checksum ? getAddress(a) : a) as `0x${string}`);

/** Options that pass the wire schema. Amounts collide on purpose so ties happen. */
const option: fc.Arbitrary<X402PaymentRequirement> = fc.record({
  scheme: fc.constantFrom('exact', 'exact', 'exact', 'upto', 'bogus') as fc.Arbitrary<X402PaymentRequirement['scheme']>,
  network: fc.constantFrom('eip155:8453', 'eip155:8453', 'eip155:84532', 'eip155:1'),
  amount: fc.constantFrom('0', '1000', '5000', '250000', '2000000'),
  asset: address,
  payTo: address,
  maxTimeoutSeconds: fc.constant(60),
  extra: fc.constant({ facilitatorAddress: POOL[2] }),
});

/** Options the wire schema has to turn away before anything else looks at them. */
const malformed: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything(),
  option.map((o) => ({ ...o, amount: '1e3' })),
  option.map((o) => ({ ...o, amount: '-5' })),
  option.map((o) => ({ ...o, network: 'eip155:8453\u001b[2J' })),
  option.map((o) => ({ ...o, payTo: '0x1234' })),
  option.map((o) => ({ ...o, maxTimeoutSeconds: Infinity })),
  option.map((o) => ({ ...o, asset: undefined }))
);

const entry = fc.oneof(
  { weight: 3, arbitrary: option.map((o) => ({ wellFormed: true as const, value: o })) },
  { weight: 1, arbitrary: malformed.map((m) => ({ wellFormed: false as const, value: m })) }
);

const policy: fc.Arbitrary<X402Policy> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({}) },
  {
    weight: 1,
    arbitrary: fc.record(
      {
        maxAmountPerPayment: fc.constantFrom('1000', '300000', '5000000'),
        allowedNetworks: fc.constant<string[]>(['eip155:8453', 'eip155:84532']),
        allowedPayTo: fc.constant<string[]>([POOL[0], POOL[1]]),
      },
      { requiredKeys: [] }
    ),
  }
);

const callerOptions: fc.Arbitrary<Pick<PayAndFetchOptions, 'maxAmount' | 'asset' | 'network'>> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({}) },
  {
    weight: 1,
    arbitrary: fc.record(
      {
        maxAmount: fc.constantFrom('1000', '250000', '5000000'),
        asset: fc.constantFrom(...POOL),
        network: fc.constantFrom('eip155:8453', 'eip155:84532'),
      },
      { requiredKeys: [] }
    ),
  }
);

type Opts = Pick<PayAndFetchOptions, 'maxAmount' | 'asset' | 'network'>;

function eligible(o: X402PaymentRequirement, p: X402Policy, opts: Opts): boolean {
  if (opts.network && o.network !== opts.network) return false;
  if (opts.asset && o.asset.toLowerCase() !== opts.asset.toLowerCase()) return false;
  if (opts.maxAmount && BigInt(o.amount) > BigInt(opts.maxAmount)) return false;
  return checkPolicy(o, p, { host: 'api.example.com' }).ok;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function challengeWith(accepts: unknown[]) {
  const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: URL_UNDER_TEST }, accepts })).toString(
    'base64'
  );
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    status: 402,
    url: URL_UNDER_TEST,
    headers: { get: (k: string) => (k === 'PAYMENT-REQUIRED' ? header : null) },
    text: async () => '',
  });
}

function traps() {
  const signed: X402PaymentRequirement[] = [];
  const funded: X402PaymentRequirement[] = [];
  const payer: Payer = {
    address: '0x0000000000000000000000000000000000000001',
    pay: async (requirement) => {
      signed.push(requirement);
      throw new Error('trap: nothing past the signature runs here');
    },
  };
  const ensureFunds = async (requirement: X402PaymentRequirement) => {
    funded.push(requirement);
    return { ok: true, skipped: true };
  };
  return { signed, funded, payer, ensureFunds };
}

const scenario = fc.tuple(fc.array(entry, { minLength: 2, maxLength: 8 }), policy, callerOptions);

describe('choosing what to pay from a 402 challenge', () => {
  it('funds and signs at most one option, the cheapest eligible one', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ([entries, p, opts]) => {
        challengeWith(entries.map((e) => e.value));
        const { signed, funded, payer, ensureFunds } = traps();

        const result = await payAndFetch(URL_UNDER_TEST, payer, { ...opts, policy: p, ensureFunds });

        const candidates = entries.flatMap((e) => (e.wellFormed && eligible(e.value, p, opts) ? [e.value] : []));
        expect(result.paid).toBe(false);
        expect(signed.length).toBeLessThanOrEqual(1);
        expect(funded).toEqual(signed);

        if (candidates.length === 0) {
          expect(signed).toEqual([]);
          expect(result.refusedReason).toMatch(/\S/);
          return;
        }
        const [chosen] = signed;
        expect(candidates).toContainEqual(chosen);
        const cheapest = candidates.reduce(
          (min, c) => (BigInt(c.amount) < min ? BigInt(c.amount) : min),
          BigInt(chosen.amount)
        );
        expect(BigInt(chosen.amount)).toBe(cheapest);
        if (chosen.scheme === 'upto') {
          expect(candidates.some((c) => c.scheme === 'exact' && c.amount === chosen.amount)).toBe(false);
        }
      })
    );
  });

  it('generates challenges where the choice is a real one', () => {
    // Guards the generator: with fewer than two distinct eligible prices, the
    // cheapest-option assertion above holds for any pick at all.
    const contested = fc.sample(scenario, 1000).filter(([entries, p, opts]) => {
      const prices = entries.flatMap((e) => (e.wellFormed && eligible(e.value, p, opts) ? [e.value.amount] : []));
      return new Set(prices).size >= 2;
    }).length;
    expect(contested).toBeGreaterThan(100);
  });

  it('a dry run never funds or signs, whatever the challenge says', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ([entries, p, opts]) => {
        challengeWith(entries.map((e) => e.value));
        const { signed, funded, payer, ensureFunds } = traps();

        await payAndFetch(URL_UNDER_TEST, payer, { ...opts, policy: p, ensureFunds, dryRun: true });

        expect(signed).toEqual([]);
        expect(funded).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      })
    );
  });

  it('a challenge that is not a well-formed list never reaches the signer', async () => {
    const header = fc.oneof(
      fc.string(),
      fc.anything().map((v) => Buffer.from(JSON.stringify(v) ?? 'null').toString('base64'))
    );
    await fc.assert(
      fc.asyncProperty(header, async (raw) => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({
          status: 402,
          url: URL_UNDER_TEST,
          headers: { get: (k: string) => (k === 'PAYMENT-REQUIRED' ? raw : null) },
          text: async () => '',
        });
        const { signed, funded, payer, ensureFunds } = traps();

        const result = await payAndFetch(URL_UNDER_TEST, payer, { ensureFunds });

        expect(result.paid).toBe(false);
        expect(signed).toEqual([]);
        expect(funded).toEqual([]);
      })
    );
  });
});
