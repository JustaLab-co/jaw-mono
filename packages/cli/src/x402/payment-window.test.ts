import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionConfig } from '../lib/session-config.js';
import type { GrantedPeriodLimit, LimitUsage, X402Policy } from './policy.js';

/**
 * The assembly both x402 front ends run before they spend. It used to live
 * twice, and the copies drifted: the grant-seeded policy reached the agent and
 * not the terminal, so the same session refused at the granted cap in one place
 * and paid under the defaults in the other.
 */

const h = vi.hoisted(() => ({
  entries: [{ at: '2026-08-01T00:00:00.000Z' }] as unknown[],
  reconciled: [] as unknown[],
  spent: 0n,
  usage: [] as unknown[],
  ledgerReads: 0,
  bridges: [] as unknown[],
  sums: [] as { entries: unknown; scope: unknown; since: unknown }[],
  topUps: [] as unknown[],
}));

vi.mock('./ledger.js', () => ({
  readX402Log: () => {
    h.ledgerReads += 1;
    return h.entries;
  },
  sumSpentSince: (entries: unknown, scope: unknown, since: unknown) => {
    h.sums.push({ entries, scope, since });
    return h.spent;
  },
}));

vi.mock('./settlement.js', () => ({
  reconcileSettlements: async (entries: unknown[]) => {
    h.reconciled.push(entries);
    // Reconciliation hands back a corrected copy, never the rows it was given.
    return entries.map((entry) => ({ ...(entry as object), reconciled: true }));
  },
}));

vi.mock('./spend-window.js', () => ({
  currentLimitUsageOnChain: async () => h.usage,
}));

vi.mock('./topup.js', () => ({
  ensurePayerFunds: async (requirement: unknown, payerAddress: unknown, executor: unknown, opts: unknown) => {
    h.topUps.push({ requirement, payerAddress, executor, opts });
    return { ok: true };
  },
}));

vi.mock('../lib/session-bridge.js', () => ({
  SessionBridge: class {
    constructor(options: unknown) {
      h.bridges.push(options);
    }
  },
}));

const { openPaymentWindow } = await import('./payment-window.js');

const PAYER = '0x00000000000000000000000000000000000000aa' as const;

const session: SessionConfig = {
  ownerAddress: '0x00000000000000000000000000000000000000bb',
  sessionAddress: PAYER,
  permissionId: '0xperm',
  chainId: 8453,
  expiry: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const limit = (over: Partial<LimitUsage> = {}): LimitUsage => ({
  allowance: '10000000',
  unit: 'day',
  multiplier: 1,
  anchor: '2026-08-01T00:00:00.000Z',
  spent: 0n,
  toppedUp: 0n,
  startedAt: new Date('2026-08-01T00:00:00.000Z'),
  endsAt: null,
  source: 'ledger',
  ...over,
});

/** What the grant states, with no meter on it: the usage list carries that. */
const granted = (over: Partial<GrantedPeriodLimit> = {}): GrantedPeriodLimit => ({
  allowance: '10000000',
  unit: 'day',
  multiplier: 1,
  anchor: '2026-08-01T00:00:00.000Z',
  ...over,
});

const policy = (over: Partial<X402Policy> = {}): X402Policy => ({
  maxTotalPerSession: '10000000',
  ...over,
});

const requirement = { network: 'eip155:8453', maxAmountRequired: '1000' } as never;

beforeEach(() => {
  h.entries = [{ at: '2026-08-01T00:00:00.000Z' }];
  h.reconciled = [];
  h.spent = 0n;
  h.usage = [];
  h.ledgerReads = 0;
  h.bridges = [];
  h.sums = [];
  h.topUps = [];
});

describe('openPaymentWindow', () => {
  it('reads the ledger once and measures both totals against the reconciled rows', async () => {
    h.usage = [limit()];

    const window = await openPaymentWindow({
      session,
      policy: policy(),
      payerAddress: PAYER,
      apiKey: 'key',
      topUpFloat: undefined,
    });

    expect(h.ledgerReads).toBe(1);
    expect(window.periodUsage).toEqual(h.usage);
    // Both figures have to count the same rows, or a cap measures against a
    // snapshot the other one never saw.
    expect(h.sums[0]?.entries).toEqual([{ at: '2026-08-01T00:00:00.000Z', reconciled: true }]);
  });

  it('counts the session total by payer since the session began', async () => {
    await openPaymentWindow({
      session,
      policy: policy(),
      payerAddress: PAYER,
      apiKey: 'key',
      topUpFloat: undefined,
    });

    // Payer and not permission: the total is the user's own ceiling and spans
    // permissions, so scoping it to the grant would reset it on `session add`.
    expect(h.sums[0]?.scope).toEqual({ payer: PAYER });
    expect(h.sums[0]?.since).toBe('2026-08-01T00:00:00.000Z');
  });

  it('builds no bridge for a dry run', async () => {
    const window = await openPaymentWindow({
      session,
      policy: policy(),
      payerAddress: PAYER,
      topUpFloat: undefined,
      apiKey: 'key',
      dryRun: true,
    });

    expect(window.ensureFunds).toBeUndefined();
    expect(h.bridges).toEqual([]);
  });

  it.each([
    ['no session', { session: null, apiKey: 'key' }],
    ['no api key', { session, apiKey: undefined }],
  ])('hands back no funding hook with %s', async (_label, over) => {
    const window = await openPaymentWindow({
      policy: policy(),
      payerAddress: PAYER,
      topUpFloat: undefined,
      ...over,
    });

    expect(window.ensureFunds).toBeUndefined();
    expect(h.bridges).toEqual([]);
  });

  it('bounds the refill by what is left of the tightest cap, not by its full width', async () => {
    // 4 USDC left on the day limit, 7 left on the session total: the day binds.
    h.usage = [limit({ allowance: '10000000', toppedUp: 6_000_000n })];
    h.spent = 3_000_000n;

    const window = await openPaymentWindow({
      session,
      policy: policy({ perPeriod: [granted()] }),
      payerAddress: PAYER,
      apiKey: 'key',
      topUpFloat: '2000000',
    });

    await window.ensureFunds?.(requirement, PAYER);

    expect(h.topUps).toHaveLength(1);
    expect(h.topUps[0]).toMatchObject({
      payerAddress: PAYER,
      opts: { maxTopUp: 4_000_000n, floatTarget: 2_000_000n, sessionChainId: 8453 },
    });
  });

  it('degrades a hand-edited float to no float instead of throwing', async () => {
    const window = await openPaymentWindow({
      session,
      policy: policy(),
      payerAddress: PAYER,
      apiKey: 'key',
      topUpFloat: 'not-a-number',
    });

    await window.ensureFunds?.(requirement, PAYER);

    expect((h.topUps[0] as { opts: { floatTarget?: bigint } }).opts.floatTarget).toBeUndefined();
  });

  it('opens one bridge however many times the hook runs', async () => {
    const window = await openPaymentWindow({
      session,
      policy: policy(),
      payerAddress: PAYER,
      apiKey: 'key',
      topUpFloat: undefined,
    });

    await window.ensureFunds?.(requirement, PAYER);
    await window.ensureFunds?.(requirement, PAYER);

    expect(h.bridges).toEqual([{ apiKey: 'key', chainId: 8453 }]);
  });
});
