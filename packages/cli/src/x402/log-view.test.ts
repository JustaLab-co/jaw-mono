import { describe, it, expect } from 'vitest';
import { renderEntry, renderSummary, hostOf, decimalsOf } from './log-view.js';
import type { X402LogEntry } from './ledger.js';

const entry = (o: Partial<X402LogEntry> = {}): X402LogEntry => ({
  at: '2026-08-04T04:07:52.900Z',
  url: 'https://api.justaname.id/ens/v2/resolve?ens=vitalik.eth',
  payer: '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F',
  status: 'paid',
  amount: '1000',
  network: 'eip155:8453',
  ...o,
});

describe('renderEntry', () => {
  it('leads with time, outcome, amount and host', () => {
    const line = renderEntry(entry());
    expect(line).toContain('2026-08-04 04:07:52');
    expect(line).toContain('paid');
    expect(line).toContain('0.001 USDC');
    expect(line).toContain('api.justaname.id');
    // The query string carries the caller's data and would drown the line.
    expect(line).not.toContain('vitalik.eth');
  });

  it('shows the transaction when there is one', () => {
    expect(renderEntry(entry({ txHash: '0xabc' }))).toContain('0xabc');
  });

  // A failed settlement may still have been broadcast; the nonce is the only way
  // to reconcile it on chain, so it must appear exactly where it is ambiguous.
  it('surfaces the nonce on a failed attempt', () => {
    expect(renderEntry(entry({ status: 'failed', nonce: '0xdeadbeef' }))).toContain('nonce 0xdeadbeef');
  });

  it('does not clutter a settled payment with the nonce', () => {
    expect(renderEntry(entry({ nonce: '0xdeadbeef' }))).not.toContain('nonce');
  });

  it('shows a top-up, since that moved user funds', () => {
    expect(renderEntry(entry({ topUpAmount: '500000' }))).toContain('topped up 0.5 USDC');
  });

  it('keeps the top-up visible on an attempt that then failed', () => {
    const line = renderEntry(entry({ status: 'failed', topUpAmount: '500000', reason: 'settlement failed' }));
    expect(line).toContain('topped up 0.5 USDC');
    expect(line).toContain('settlement failed');
  });

  it('renders a refusal with its reason and no amount', () => {
    const line = renderEntry(entry({ status: 'refused', amount: undefined, reason: 'over cap' }));
    expect(line).toContain('refused');
    expect(line).toContain('over cap');
    expect(line).not.toContain('USDC');
  });
});

// A refusal reason is stored server text. Without disarming it, an endpoint
// that got refused once repaints this line on every later `x402 log`.
describe('renderEntry against a poisoned ledger', () => {
  const ESC = String.fromCharCode(0x1b);
  const CR = String.fromCharCode(0x0d);

  it('renders a reason carrying escape sequences inert', () => {
    const line = renderEntry(
      entry({
        status: 'refused',
        amount: undefined,
        reason: `network not allowed${ESC}[2K${CR}${ESC}[32m  Paid. 5 USDC${ESC}[0m`,
      })
    );
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(CR);
    expect(line).toContain('network not allowed');
  });

  it('disarms a url that never parsed as one', () => {
    const line = renderEntry(entry({ url: `not-a-url${ESC}[2K` }));
    expect(line).not.toContain(ESC);
  });

  it('bounds a very long reason instead of flooding the terminal', () => {
    const line = renderEntry(entry({ status: 'refused', amount: undefined, reason: 'z'.repeat(5000) }));
    expect(line).toContain('more characters');
    expect(line.length).toBeLessThan(1000);
  });
});

// The ledger is a file on disk. Nothing read back from it is trusted for having
// been written by us, so a tampered row cannot paint one either.
describe('renderEntry against a tampered ledger', () => {
  const ESC = String.fromCharCode(0x1b);

  it('disarms the timestamp', () => {
    expect(renderEntry(entry({ at: `${ESC}[2K${ESC}[31mFAKE` }))).not.toContain(ESC);
  });

  it('disarms the status', () => {
    expect(renderEntry(entry({ status: `paid${ESC}[31m` as never }))).not.toContain(ESC);
  });

  it('disarms an amount that is not a number', () => {
    expect(renderEntry(entry({ amount: `1${ESC}[32m` }))).not.toContain(ESC);
  });
});

describe('renderSummary', () => {
  // Same rule the spend caps use: a refusal never signed anything.
  it('counts paid and failed as money out, never refused', () => {
    const summary = renderSummary([
      entry({ amount: '1000' }),
      entry({ status: 'failed', amount: '1000' }),
      entry({ status: 'refused', amount: '9999999' }),
    ]);
    expect(summary).toContain('0.002 USDC out');
    expect(summary).toContain('1 paid');
    expect(summary).toContain('1 failed');
    expect(summary).toContain('1 refused');
  });

  it('mentions only the outcomes that occurred', () => {
    const summary = renderSummary([entry(), entry()]);
    expect(summary).toContain('2 paid');
    expect(summary).not.toContain('failed');
    expect(summary).not.toContain('refused');
  });

  // The ledger is a file a person can edit, and `in` reads the prototype: a row
  // saying `constructor` was counted on a key nothing reads and vanished from
  // both tallies, quietly shrinking the reported total.
  it('counts a row naming a prototype member as unreadable, not as nothing', () => {
    const summary = renderSummary([entry(), entry({ status: 'constructor' as X402LogEntry['status'] })]);
    expect(summary).toContain('1 paid');
    expect(summary).toContain('1 unreadable');
  });

  it('survives a hand-edited amount instead of breaking the whole summary', () => {
    expect(renderSummary([entry({ amount: 'oops' }), entry({ amount: '1000' })])).toContain('0.001 USDC out');
  });

  // Base units from tokens with different decimals are not the same unit.
  // Adding them and formatting with one scale would print a confident wrong
  // number, so each scale is totalled on its own.
  it('does not merge totals across different decimal scales', () => {
    const six = entry({ amount: '1000000', network: 'eip155:8453' }); // 1 USDC
    const unknown = entry({ amount: '1000000', network: 'eip155:999999' }); // falls back to 6
    // Same scale, so a single figure.
    expect(renderSummary([six, unknown])).toContain('2 USDC out');
  });

  // An unrecognised status landed on `counts` as a stray key and disappeared
  // from the tally, so a malformed row silently shrank the reported total.
  it('reports unreadable rows instead of dropping them', () => {
    const summary = renderSummary([entry(), entry({ status: 'settled' as never })]);
    expect(summary).toContain('1 unreadable');
    expect(summary).toContain('1 paid');
  });

  it('says nothing about unreadable rows when there are none', () => {
    expect(renderSummary([entry()])).not.toContain('unreadable');
  });

  it('reports zero out when everything was refused', () => {
    expect(renderSummary([entry({ status: 'refused', amount: undefined })])).toContain('0 USDC out');
  });
});

describe('decimalsOf', () => {
  it('reads the decimals of the entry own network', () => {
    expect(decimalsOf(entry({ network: 'eip155:8453' }))).toBe(6);
  });

  it('falls back for an unknown or absent network rather than throwing', () => {
    expect(decimalsOf(entry({ network: 'eip155:999999' }))).toBe(6);
    expect(decimalsOf(entry({ network: undefined }))).toBe(6);
  });
});

describe('hostOf', () => {
  it('reduces a url to its host', () => {
    expect(hostOf('https://api.example.com/a/b?c=d')).toBe('api.example.com');
    expect(hostOf('http://localhost:8402/paid')).toBe('localhost:8402');
  });

  it('returns a malformed url unchanged instead of throwing', () => {
    expect(hostOf('not a url')).toBe('not a url');
  });
});

/**
 * `jaw x402 log` and the caps have to report the same number. A failed attempt
 * holds the ceiling it authorized, so a log that showed the charge would tell a
 * user they had spent four cents while five dollars of their budget was gone.
 */
describe('log view against the enforced spend rule', () => {
  const failedUpto = entry({ status: 'failed', amount: '40', authorized: '5000000' });

  it('shows what a failed attempt reserved, not what it tried to pay', () => {
    expect(renderEntry(failedUpto)).toContain('5 USDC');
  });

  it('totals the reserved figure in the summary', () => {
    expect(renderSummary([failedUpto])).toContain('5 USDC out');
  });

  it('leaves a settled payment reporting what settled', () => {
    expect(renderEntry(entry({ status: 'paid', amount: '40', authorized: '5000000' }))).toContain('0.00004 USDC');
  });
});

describe('log view of a compaction checkpoint', () => {
  const checkpoint = entry({
    kind: 'checkpoint',
    folded: 812,
    url: 'jaw:compacted',
    amount: '3200000',
  });

  it('reads as a fold rather than as a payment', () => {
    const line = renderEntry(checkpoint);
    expect(line).toContain('folded');
    expect(line).toContain('812 earlier payments');
    expect(line).toContain('3.2 USDC');
    expect(line).not.toContain('paid');
  });

  it('counts its figure in the total but not as one paid payment', () => {
    const summary = renderSummary([entry({ amount: '1000' }), checkpoint]);
    expect(summary).toContain('1 paid');
    expect(summary).toContain('812 folded away');
    expect(summary).toContain('3.201 USDC out');
  });
});

describe('a tampered checkpoint cannot paint the terminal', () => {
  it('sanitizes the folded count like every other field', () => {
    const escape = String.fromCharCode(27);
    const painted = entry({ kind: 'checkpoint', folded: `${escape}[31mred` as unknown as number });
    expect(renderEntry(painted)).not.toContain(escape);
  });
});
