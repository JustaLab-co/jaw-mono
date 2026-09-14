import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionConfig } from '../lib/session-config.js';
import type { LimitUsage, X402Policy } from './policy.js';

/**
 * What `topUpCeiling` sizes refills from, and what `jaw x402 status` prints as
 * the remaining grant. The ledger's answer is a floor by construction: it sees
 * what went through `payAndFetch` and nothing else, so a pull made through
 * `jaw_rpc`, from a second machine, or by a write that never landed is missing
 * from it. The contract meters the real pull, so the undercount does not
 * overspend the allowance; it sends a userOp that reverts.
 */

const h = vi.hoisted(() => ({
  toppedUp: 0n,
  spent: 0n,
  onChain: { status: 'unavailable' } as
    | { status: 'ok'; start: number; end: number; spend: bigint }
    | { status: 'outside-window' }
    | { status: 'unavailable' },
  reads: 0,
  summed: [] as unknown[],
  scopes: [] as unknown[],
}));

vi.mock('./ledger.js', () => ({
  sumToppedUpSince: (entries: unknown, scope: unknown) => {
    h.summed.push(entries);
    h.scopes.push(scope);
    return h.toppedUp;
  },
  sumSpentSince: (entries: unknown, scope: unknown) => {
    h.summed.push(entries);
    h.scopes.push(scope);
    return h.spent;
  },
}));

vi.mock('./permission-onchain.js', () => ({
  readCurrentPeriods: async () => {
    h.reads += 1;
    return h.onChain === null
      ? []
      : [{ token: USDC, unit: 'day', multiplier: 1, allowance: '5000000', period: h.onChain }];
  },
}));

const { currentLimitUsage, currentLimitUsageOnChain, capWindowStarts } = await import('./spend-window.js');

// The caller's snapshot of the ledger. Its contents do not matter here: the
// sums are mocked, and what these tests are about is the windows.
const LEDGER: never[] = [];
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const ANCHOR = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-08-01T06:00:00.000Z');
const CHAIN_WINDOW = { start: 1_754_006_400, end: 1_754_092_800 };

const POLICY: X402Policy = {
  perPeriod: [{ allowance: '5000000', unit: 'day', multiplier: 1, anchor: ANCHOR.toISOString() }],
};

const SESSION = {
  ownerAddress: '0x2222222222222222222222222222222222222222',
  sessionAddress: '0x1111111111111111111111111111111111111111',
  permissionId: '0xabc',
  chainId: 84532,
  expiry: Math.floor(NOW.getTime() / 1000) + 6 * 86400,
  createdAt: ANCHOR.toISOString(),
  mode: 'eip7702' as const,
} satisfies SessionConfig;

const PAYER = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  h.toppedUp = 0n;
  h.spent = 0n;
  h.onChain = { status: 'unavailable' };
  h.reads = 0;
  h.summed = [];
  h.scopes = [];
});

describe('currentLimitUsage', () => {
  it('marks the ledger as the source, because from there the figure is a floor', () => {
    h.toppedUp = 1_000_000n;
    expect(currentLimitUsage(LEDGER, POLICY, PAYER, SESSION, NOW)[0]).toMatchObject({
      toppedUp: 1_000_000n,
      source: 'ledger',
    });
  });

  it('is empty when no grant seeded a limit, so only the session cap applies', () => {
    expect(currentLimitUsage(LEDGER, {}, PAYER, SESSION, NOW)).toEqual([]);
  });

  // One read per payment: every limit is counted against the rows the caller
  // read under the lock, not against a read of the sum's own.
  it('counts every limit against the rows it was handed', () => {
    currentLimitUsage(LEDGER, POLICY, PAYER, SESSION, NOW);
    expect(h.summed.length).toBeGreaterThan(0);
    expect(h.summed.every((entries) => entries === LEDGER)).toBe(true);
  });
});

describe('currentLimitUsageOnChain', () => {
  /**
   * The case the review named: a pull the ledger never saw. Reporting the
   * ledger's 1 against a 5 already gone would size the next refill against
   * budget that does not exist.
   */
  it('takes the chain figure when it is ahead of the ledger', async () => {
    h.toppedUp = 1_000_000n;
    h.onChain = { status: 'ok', ...CHAIN_WINDOW, spend: 5_000_000n };

    const [period] = await currentLimitUsageOnChain(LEDGER, POLICY, PAYER, SESSION, NOW);
    expect(period).toMatchObject({ toppedUp: 5_000_000n, source: 'chain', endsAt: new Date(CHAIN_WINDOW.end * 1000) });
  });

  /**
   * The other direction, and the reason the two are combined rather than one
   * replacing the other: our own top-up is signed and not yet mined, so the
   * chain has not lost it yet and is about to.
   */
  it('keeps the ledger figure when it is ahead of the chain', async () => {
    h.toppedUp = 5_000_000n;
    h.onChain = { status: 'ok', ...CHAIN_WINDOW, spend: 0n };

    const [period] = await currentLimitUsageOnChain(LEDGER, POLICY, PAYER, SESSION, NOW);
    // Reported as the ledger's, because that is what it is: our own estimate of
    // a pull that has not been mined. Calling it the chain's would let the
    // report print an estimate as a metered total. The window is still the
    // contract's either way.
    expect(period).toMatchObject({ toppedUp: 5_000_000n, source: 'ledger', endsAt: new Date(CHAIN_WINDOW.end * 1000) });
  });

  it('reports the chain as the source when the two agree', async () => {
    h.toppedUp = 5_000_000n;
    h.onChain = { status: 'ok', ...CHAIN_WINDOW, spend: 5_000_000n };
    expect((await currentLimitUsageOnChain(LEDGER, POLICY, PAYER, SESSION, NOW))[0]).toMatchObject({ source: 'chain' });
  });

  it('counts the ledger over the window the contract is actually in', async () => {
    h.onChain = { status: 'ok', ...CHAIN_WINDOW, spend: 0n };
    const [period] = await currentLimitUsageOnChain(LEDGER, POLICY, PAYER, SESSION, NOW);
    expect(period?.endsAt).toEqual(new Date(CHAIN_WINDOW.end * 1000));
  });

  it('falls back to the ledger when the node does not answer', async () => {
    h.toppedUp = 2_000_000n;
    const [period] = await currentLimitUsageOnChain(LEDGER, POLICY, PAYER, SESSION, NOW);
    expect(period).toMatchObject({ toppedUp: 2_000_000n, source: 'ledger' });
  });

  // Expiry is reported on its own, and the local window still describes a
  // permission the contract will no longer meter.
  it('falls back to the ledger for a permission outside its own window', async () => {
    h.toppedUp = 2_000_000n;
    h.onChain = { status: 'outside-window' };
    const [period] = await currentLimitUsageOnChain(LEDGER, POLICY, PAYER, SESSION, NOW);
    expect(period).toMatchObject({ toppedUp: 2_000_000n, source: 'ledger' });
  });

  it('does not read the chain on a chain with no registry asset to meter', async () => {
    const elsewhere = { ...SESSION, chainId: 1 };
    const [period] = await currentLimitUsageOnChain(LEDGER, POLICY, PAYER, elsewhere, NOW);
    expect(period?.source).toBe('ledger');
    expect(h.reads).toBe(0);
  });

  it('does not read the chain when no period applies at all', async () => {
    expect(await currentLimitUsageOnChain(LEDGER, {}, PAYER, SESSION, NOW)).toEqual([]);
    expect(h.reads).toBe(0);
  });
});

/**
 * The window is read per permission, not per payer. One permission carries one
 * allowance and every spender under it draws on the same counter, so a scope
 * that lost the permission would measure each spender against its own copy of a
 * cap the chain meters once.
 */
describe('the ledger is asked about the session permission', () => {
  it('carries the permission and the payer into every sum', () => {
    currentLimitUsage(LEDGER, POLICY, PAYER, SESSION, NOW);

    expect(h.scopes.length).toBeGreaterThan(0);
    for (const scope of h.scopes) {
      expect(scope).toEqual({ permissionId: SESSION.permissionId, payer: PAYER });
    }
  });

  it('asks about the payer alone when the session names no permission', () => {
    currentLimitUsage(LEDGER, POLICY, PAYER, { expiry: SESSION.expiry }, NOW);

    expect(h.scopes.length).toBeGreaterThan(0);
    for (const scope of h.scopes) {
      expect(scope).toEqual({ permissionId: undefined, payer: PAYER });
    }
  });
});

describe('capWindowStarts', () => {
  const limit = (startedAt: string) => ({ startedAt: new Date(startedAt) }) as LimitUsage;

  it('offers one instant per live limit plus the session start', () => {
    const starts = capWindowStarts(
      [limit('2026-07-01T00:00:00.000Z'), limit('2026-07-15T00:00:00.000Z')],
      '2026-06-01T00:00:00.000Z'
    );
    expect(starts).toEqual(['2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);
  });

  it('offers nothing for a session with no createdAt', () => {
    // That total is summed with no `since` at all, so it counts every row and
    // every checkpoint alike and imposes no cut.
    expect(capWindowStarts([], undefined)).toEqual([]);
  });
});
