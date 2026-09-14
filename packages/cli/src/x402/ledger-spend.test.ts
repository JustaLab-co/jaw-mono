import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SpendScope } from './ledger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-ledger-spend-test');

vi.mock('../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-ledger-spend-test');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});

const { appendX402Log, readX402Log, sumSpentSince, sumToppedUpSince } = await import('./ledger.js');

// The sums take the rows now, so each assertion reads back the file it wrote.
const spentBy = (scope: SpendScope, since?: string) => sumSpentSince(readX402Log(), scope, since);
const toppedUpBy = (scope: SpendScope, since?: string) => sumToppedUpSince(readX402Log(), scope, since);

const PAYER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PERMISSION = '0xaaaa';
const OTHER_PERMISSION = '0xbbbb';

/** The scope the sums count over. Payer only, unless a case is about permissions. */
const of = (payer: string, permissionId?: string) => ({ payer, permissionId });

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

const entry = (o: Partial<Parameters<typeof appendX402Log>[0]>) =>
  appendX402Log({
    at: '2026-02-01T00:00:00.000Z',
    url: 'https://api.example.com/x',
    payer: PAYER,
    status: 'paid',
    amount: '1000',
    ...o,
  } as Parameters<typeof appendX402Log>[0]);

describe('sumSpentSince', () => {
  it('adds settled payments for this payer', () => {
    entry({});
    entry({ amount: '2500' });
    expect(spentBy(of(PAYER))).toBe(3500n);
  });

  // A signed authorization may have been broadcast even when settlement did not
  // confirm, so counting it can only under-spend the cap, never breach it.
  it('counts failed attempts, not refusals', () => {
    entry({ status: 'failed', amount: '1000' });
    entry({ status: 'refused', amount: '9999' });
    expect(spentBy(of(PAYER))).toBe(1000n);
  });

  it('ignores other payers', () => {
    entry({ payer: OTHER, amount: '5000' });
    expect(spentBy(of(PAYER))).toBe(0n);
  });

  it('matches the payer case-insensitively', () => {
    entry({ payer: PAYER.toUpperCase().replace('0X', '0x') });
    expect(spentBy(of(PAYER))).toBe(1000n);
  });

  it('scopes to entries at or after the cutoff', () => {
    entry({ at: '2026-01-01T00:00:00.000Z', amount: '4000' });
    entry({ at: '2026-03-01T00:00:00.000Z', amount: '1000' });
    expect(spentBy(of(PAYER), '2026-02-01T00:00:00.000Z')).toBe(1000n);
    expect(spentBy(of(PAYER))).toBe(5000n);
  });

  it('skips a hand-edited amount instead of taking the cap down', () => {
    entry({ amount: 'not-a-number' });
    entry({ amount: '1000' });
    expect(spentBy(of(PAYER))).toBe(1000n);
  });

  it('is zero on an empty ledger', () => {
    expect(spentBy(of(PAYER))).toBe(0n);
  });
});

describe('sumToppedUpSince', () => {
  it('adds what was pulled through the permission, not what was paid', () => {
    entry({ amount: '1000', topUpAmount: '5000' });
    entry({ amount: '1000' }); // paid out of the float, no pull
    expect(toppedUpBy(of(PAYER))).toBe(5000n);
    expect(spentBy(of(PAYER))).toBe(2000n);
  });

  // The pull settled before the payment it was meant for was attempted, so the
  // allowance is gone whatever the payment ended up doing.
  it('counts a pull whose payment was then refused', () => {
    entry({ status: 'refused', amount: undefined, topUpAmount: '5000' });
    expect(toppedUpBy(of(PAYER))).toBe(5000n);
  });

  it('ignores other payers and entries before the cutoff', () => {
    entry({ payer: OTHER, topUpAmount: '9000' });
    entry({ at: '2026-01-01T00:00:00.000Z', topUpAmount: '4000' });
    entry({ at: '2026-03-01T00:00:00.000Z', topUpAmount: '1000' });
    expect(toppedUpBy(of(PAYER), '2026-02-01T00:00:00.000Z')).toBe(1000n);
  });

  it('skips a hand-edited amount instead of taking the cap down', () => {
    entry({ topUpAmount: 'not-a-number' });
    entry({ topUpAmount: '1000' });
    expect(toppedUpBy(of(PAYER))).toBe(1000n);
  });

  it('is zero when nothing was ever topped up', () => {
    entry({ amount: '1000' });
    expect(toppedUpBy(of(PAYER))).toBe(0n);
  });
});

/**
 * Under `upto` the ceiling and the charge are different numbers, and which one
 * a cap must count depends on whether the payment settled. A settled one costs
 * what settled. A failed one leaves a signature that is still spendable up to
 * the ceiling, so it costs all of it.
 */
describe('sumSpentSince with a ceiling that differs from the charge', () => {
  it('counts what settled when the payment settled', () => {
    entry({ status: 'paid', amount: '40', authorized: '5000000' });
    expect(spentBy(of(PAYER))).toBe(40n);
  });

  it('counts the whole ceiling when settlement failed', () => {
    entry({ status: 'failed', amount: '40', authorized: '5000000' });
    expect(spentBy(of(PAYER))).toBe(5_000_000n);
  });

  it('still counts nothing for an attempt that was never signed', () => {
    entry({ status: 'refused', amount: '40', authorized: '5000000' });
    expect(spentBy(of(PAYER))).toBe(0n);
  });

  it('leaves the exact scheme untouched, where both figures are the same', () => {
    entry({ status: 'failed', amount: '1000', authorized: '1000' });
    expect(spentBy(of(PAYER))).toBe(1000n);
  });

  it('reads an entry written before the ceiling was recorded', () => {
    entry({ status: 'failed', amount: '1000' });
    expect(spentBy(of(PAYER))).toBe(1000n);
  });

  // The row still counts what it can be read for. An unparseable ceiling
  // reading as zero would have let one corrupt field, or a torn write, shrink
  // an enforced cap, which is the opposite of what a conservative rule does.
  it('falls back to the charge when the ceiling is unreadable', () => {
    entry({ status: 'failed', amount: '1000', authorized: 'not-a-number' });
    entry({ status: 'paid', amount: '25' });
    expect(spentBy(of(PAYER))).toBe(1025n);
  });

  it('takes the larger of the two, so neither field alone can shrink the cap', () => {
    entry({ status: 'failed', amount: '9000', authorized: '40' });
    expect(spentBy(of(PAYER))).toBe(9000n);
  });

  it('ignores a negative figure instead of subtracting it', () => {
    entry({ status: 'paid', amount: '-5000' });
    entry({ status: 'paid', amount: '25' });
    expect(spentBy(of(PAYER))).toBe(25n);
  });
});

/**
 * The defect this file exists to pin. Two sessions granted 10 a day spend 20 a
 * day, because each spender was measured against its own copy of a cap the chain
 * meters once, per permission.
 */
describe('the permission is the unit of account, not the payer', () => {
  it('sums two payers spending under the same permission', () => {
    entry({ payer: PAYER, permissionId: PERMISSION, amount: '1000' });
    entry({ payer: OTHER, permissionId: PERMISSION, amount: '1500' });

    expect(spentBy(of(PAYER, PERMISSION))).toBe(2500n);
  });

  it('keeps two permissions apart even when one payer holds both', () => {
    entry({ payer: PAYER, permissionId: PERMISSION, amount: '1000' });
    entry({ payer: PAYER, permissionId: OTHER_PERMISSION, amount: '9000' });

    expect(spentBy(of(PAYER, PERMISSION))).toBe(1000n);
    expect(spentBy(of(PAYER, OTHER_PERMISSION))).toBe(9000n);
  });

  it('matches the permission case-insensitively', () => {
    entry({ permissionId: '0xAAAA', amount: '1000' });

    expect(spentBy(of(PAYER, '0xaaaa'))).toBe(1000n);
  });

  it('counts top-ups the same way', () => {
    entry({ payer: PAYER, permissionId: PERMISSION, topUpAmount: '4000' });
    entry({ payer: OTHER, permissionId: PERMISSION, topUpAmount: '1000' });

    expect(toppedUpBy(of(PAYER, PERMISSION))).toBe(5000n);
  });

  // Every row already on disk when this shipped has no permission. Dropping them
  // would reset a live cap to zero and hand an agent its whole allowance back
  // mid-period, which is a spend and not a display bug.
  it('still charges an entry with no permission to its payer', () => {
    entry({ payer: PAYER, amount: '1000' }); // written before the field existed
    entry({ payer: PAYER, permissionId: PERMISSION, amount: '500' });

    expect(spentBy(of(PAYER, PERMISSION))).toBe(1500n);
  });

  it("does not borrow another payer's entry that has no permission", () => {
    entry({ payer: OTHER, amount: '9000' });

    expect(spentBy(of(PAYER, PERMISSION))).toBe(0n);
  });

  // No session means no permission to scope by, which is what the payer filter
  // has always done and still has to do.
  it('falls back to the payer when the scope names no permission', () => {
    entry({ payer: PAYER, permissionId: PERMISSION, amount: '1000' });
    entry({ payer: OTHER, permissionId: PERMISSION, amount: '9000' });

    expect(spentBy(of(PAYER))).toBe(1000n);
  });
});

/**
 * The two meters ask different questions and take different scopes. The
 * per-period figures mirror an on-chain counter that a new permission resets, so
 * they scope to the permission. The session total is measured against
 * `maxTotalPerSession`, the user's own ceiling, and `session add` preserves
 * `createdAt` so that adding a capability cannot reset it. Scoping that one to
 * the permission would hand back the same clean slate through the other door,
 * because `session add` issues a new permission id.
 */
describe('a session total spans the permissions the payer has held', () => {
  it('counts spend from a permission the session no longer names', () => {
    entry({ payer: PAYER, permissionId: PERMISSION, amount: '1000' });
    entry({ payer: PAYER, permissionId: OTHER_PERMISSION, amount: '500' });

    expect(spentBy(of(PAYER))).toBe(1500n);
  });

  it('still keeps another payer out of it', () => {
    entry({ payer: PAYER, permissionId: PERMISSION, amount: '1000' });
    entry({ payer: OTHER, permissionId: PERMISSION, amount: '9000' });

    expect(spentBy(of(PAYER))).toBe(1000n);
  });
});

/**
 * A payment reads the ledger once and counts every one of its caps against that
 * read, so a row appended afterwards lands on the next payment and not on the
 * one already in flight.
 */
describe('the rows a sum is handed', () => {
  it('counts the snapshot it was given, not the file as it stands now', () => {
    entry({ amount: '1000' });
    const snapshot = readX402Log();
    entry({ amount: '4000' });

    expect(sumSpentSince(snapshot, of(PAYER))).toBe(1000n);
    expect(spentBy(of(PAYER))).toBe(5000n);
  });

  it('a row written before the field keeps counting the amount it reported', () => {
    // History. Re-reading these as ceilings would jam every cap that is live today.
    appendX402Log({
      at: '2026-07-16T00:00:00.000Z',
      url: 'https://a',
      payer: PAYER,
      status: 'paid',
      amount: '5',
      authorized: '1000',
    });

    expect(spentBy(of(PAYER))).toBe(5n);
  });

  it('an unchecked payment costs its ceiling, the same as a failed one', () => {
    appendX402Log({
      at: '2026-07-16T00:00:00.000Z',
      url: 'https://a',
      payer: PAYER,
      status: 'paid',
      amount: '5',
      authorized: '1000',
      settlement: 'unverified',
    });

    expect(spentBy(of(PAYER))).toBe(1000n);
  });

  it('an authorization that expired unspent costs nothing', () => {
    appendX402Log({
      at: '2026-07-16T00:00:00.000Z',
      url: 'https://a',
      payer: PAYER,
      status: 'failed',
      amount: '0',
      authorized: '1000',
      settlement: 'expired',
    });

    expect(spentBy(of(PAYER))).toBe(0n);
  });

  it('a settlement value it does not recognise lands on the ceiling', () => {
    // A typo, a torn write, a hand edit. Named states only, so an unreadable
    // one cannot shrink an enforced cap.
    appendX402Log({
      at: '2026-07-16T00:00:00.000Z',
      url: 'https://a',
      payer: PAYER,
      status: 'paid',
      amount: '5',
      authorized: '1000',
      settlement: 'unverifed' as never,
    });

    expect(spentBy(of(PAYER))).toBe(1000n);
  });
});
