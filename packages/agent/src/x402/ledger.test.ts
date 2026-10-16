import { describe, expect, it } from 'vitest';
import { sumToppedUpSince, type X402LogEntry } from './ledger.js';

const scope = { permissionId: '0xperm', payer: '0x1111111111111111111111111111111111111111' };
const entry = (at: string, topUpAt?: string): X402LogEntry => ({
  at,
  url: 'https://seller.example',
  payer: scope.payer,
  permissionId: scope.permissionId,
  status: 'paid',
  amount: '1000000',
  topUpAmount: '1000000',
  topUpAt,
});

describe('sumToppedUpSince', () => {
  const today = '2026-10-14T00:00:00.000Z';

  it('given a top-up pulled yesterday for a payment signed today, then it counts yesterday, not today', () => {
    const entries = [entry('2026-10-14T00:05:00.000Z', '2026-10-13T23:59:00.000Z')];
    expect(sumToppedUpSince(entries, scope, today)).toBe(0n);
    expect(sumToppedUpSince(entries, scope, '2026-10-13T00:00:00.000Z')).toBe(1_000_000n);
  });

  it('given an entry with no top-up time, then the top-up counts at the entry time', () => {
    expect(sumToppedUpSince([entry('2026-10-14T00:05:00.000Z')], scope, today)).toBe(1_000_000n);
    expect(sumToppedUpSince([entry('2026-10-13T23:59:00.000Z')], scope, today)).toBe(0n);
  });
});
