import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { X402LogEntry } from './ledger.js';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-ledger-compaction-test');

/**
 * A one-shot hook fired after the next `writeFileSync`, which is how a test
 * gets between the temp write and the rename. `vi.spyOn` cannot reach an ESM
 * export, so the module is wrapped instead and everything else passes through.
 */
const hooks = vi.hoisted(() => ({ afterWrite: null as (() => void) | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      actual.writeFileSync(...args);
      const hook = hooks.afterWrite;
      hooks.afterWrite = null;
      hook?.();
    },
  };
});

vi.mock('../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-ledger-compaction-test');
  return {
    PATHS: {
      root,
      x402Log: p.join(root, 'x402-log.jsonl'),
      x402LogArchive: p.join(root, 'x402-log.archive.jsonl'),
    },
  };
});

const { appendX402Log, compactX402Log, readX402Log, sumSpentSince, sumToppedUpSince } = await import('./ledger.js');
const { PATHS } = await import('../lib/paths.js');

const PAYER_A = '0x0000000000000000000000000000000000000001';
const PAYER_B = '0x0000000000000000000000000000000000000002';
const PERM_A = '0xaaaa';
const PERM_B = '0xbbbb';

let clock = 0;
const at = () => new Date((clock += 1000)).toISOString();

const row = (over: Partial<X402LogEntry> = {}): X402LogEntry => ({
  at: at(),
  url: 'https://api.example.com/x',
  payer: PAYER_A,
  status: 'paid',
  amount: '1000',
  network: 'base-sepolia',
  ...over,
});

const serialize = (entries: X402LogEntry[]) => entries.map((entry) => '\n' + JSON.stringify(entry)).join('');

function writeLedger(entries: X402LogEntry[]): void {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(PATHS.x402Log, serialize(entries), { mode: 0o600 });
}

/**
 * Filler carrying no spend, enough on its own to clear the 2 MiB threshold.
 * Counted incrementally rather than by re-serialising the list, which would be
 * quadratic at this size. It is written before whatever a test cares about, so
 * the rows under test are the newest absorbed ones.
 */
function filler(): X402LogEntry[] {
  const rows: X402LogEntry[] = [];
  let bytes = 0;
  while (bytes < 2 * 1024 * 1024) {
    const one = row({ status: 'refused', amount: undefined });
    rows.push(one);
    bytes += JSON.stringify(one).length + 1;
  }
  return rows;
}

/** Rows newer than the cut, so the fold has something to leave alone. */
const tail = () => Array.from({ length: 220 }, () => row({ amount: '1' }));

/** Every figure the caps enforce, for one scope, at every instant they ask about. */
const figures = (scope: { permissionId?: string; payer: string }, sinces: (string | undefined)[]) =>
  sinces.map((since) => {
    // Re-read per call, so before and after a fold are measured off the file.
    const entries = readX402Log();
    return [sumSpentSince(entries, scope, since).toString(), sumToppedUpSince(entries, scope, since).toString()];
  });

beforeEach(() => {
  clock = Date.parse('2026-07-01T00:00:00.000Z');
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});
afterEach(() => {
  hooks.afterWrite = null;
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('x402 ledger compaction', () => {
  it('leaves a ledger under the threshold byte for byte', () => {
    writeLedger([row(), row(), row()]);
    const before = fs.readFileSync(PATHS.x402Log);

    compactX402Log([new Date(clock + 60_000).toISOString()], PAYER_A);

    expect(fs.readFileSync(PATHS.x402Log).equals(before)).toBe(true);
    expect(fs.existsSync(PATHS.x402LogArchive)).toBe(false);
  });

  it('keeps every enforced figure identical across a fold', () => {
    // Several scopes at once, because a checkpoint is per scope and the sums
    // route by permission before falling back to the payer.
    const bulk = filler();
    const meaningful = [
      row({ permissionId: PERM_A, amount: '1500' }),
      row({ permissionId: PERM_A, status: 'failed', authorized: '9000', amount: '10' }),
      row({ permissionId: PERM_A, topUpAmount: '4000' }),
      row({ permissionId: PERM_B, amount: '2500', topUpAmount: '7000' }),
      row({ payer: PAYER_B, amount: '800' }),
      row({ amount: '600' }), // no permission at all, charged to its payer
      row({ status: 'refused', amount: undefined, topUpAmount: '300' }),
    ];
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, ...meaningful, ...tail()]);

    const sinces = [undefined, '2026-07-01T00:00:00.000Z', cut];
    const scopes = [
      { permissionId: PERM_A, payer: PAYER_A },
      { permissionId: PERM_B, payer: PAYER_A },
      { payer: PAYER_A },
      { payer: PAYER_B },
    ];
    const before = scopes.map((scope) => figures(scope, sinces));

    compactX402Log([cut], PAYER_A);

    expect(scopes.map((scope) => figures(scope, sinces))).toEqual(before);
    expect(readX402Log().some((entry) => entry.kind === 'checkpoint')).toBe(true);
  });

  it("leaves another payer's rows alone, since its windows are not in capStarts", () => {
    // `capStarts` describes the windows of the payer that is paying. A second
    // key on one machine, which `session setup` makes whenever it does not reuse
    // one, has windows nobody passed in, and one of them lands inside the range
    // this fold would absorb.
    const bulk = filler();
    const beforeWindow = row({ payer: PAYER_B, amount: '700' });
    const windowStart = new Date(clock + 500).toISOString();
    const insideWindow = row({ payer: PAYER_B, amount: '300' });
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, beforeWindow, insideWindow, ...tail()]);

    compactX402Log([cut], PAYER_A);

    // Folded, the two would come back as one checkpoint stamped after B's
    // window started, so B would read 1000 spent inside it and refuse payments
    // its cap still allows.
    expect(sumSpentSince(readX402Log(), { payer: PAYER_B }, windowStart)).toBe(300n);
  });

  it('folds with no cap start above the oldest row, keeping the tail', () => {
    writeLedger([...filler(), row({ amount: '1200' }), ...tail()]);
    const before = figures({ payer: PAYER_A }, [undefined]);
    const rowsBefore = readX402Log().length;

    compactX402Log([], PAYER_A);

    const after = readX402Log();
    expect(figures({ payer: PAYER_A }, [undefined])).toEqual(before);
    expect(after.length).toBeLessThan(rowsBefore);
    expect(after.filter((entry) => entry.kind !== 'checkpoint')).toHaveLength(200);
  });

  it('folds nothing when no cap start could be read', () => {
    // `capWindowStarts` withholds the whole list when one window start is
    // unreadable. An empty list is the opposite instruction, so the two must not
    // be confused: here the file is left exactly as it was.
    writeLedger([...filler(), row({ amount: '1200' }), ...tail()]);
    const before = fs.readFileSync(PATHS.x402Log);

    compactX402Log(undefined, PAYER_A);

    expect(fs.readFileSync(PATHS.x402Log).equals(before)).toBe(true);
    expect(fs.existsSync(PATHS.x402LogArchive)).toBe(false);
  });

  it('stamps the checkpoint at the newest row it absorbed, not at now', () => {
    const bulk = filler();
    const last = row({ amount: '200' });
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, last, ...tail()]);

    compactX402Log([cut], PAYER_A);

    const checkpoint = readX402Log().find((entry) => entry.kind === 'checkpoint');
    expect(checkpoint?.at).toBe(last.at);
    expect(last.at < cut).toBe(true);
  });

  it('takes the cut from the oldest stamp, not the first row in the file', () => {
    // A clock that stepped backwards leaves the file out of time order. Reading
    // the cut off the wrong end moves it past a `since` that is still counting,
    // and the checkpoint then lands on the counted side of it.
    const bulk = filler();
    const late = row({ amount: '5000' }); // written first, stamped later
    const early = { ...row({ amount: '7000' }), at: '2026-06-01T00:00:00.000Z' };
    const capStart = '2026-06-15T00:00:00.000Z'; // between the two
    writeLedger([...bulk, late, early, ...tail()]);

    const before = figures({ payer: PAYER_A }, [capStart]);
    compactX402Log([capStart], PAYER_A);

    expect(figures({ payer: PAYER_A }, [capStart])).toEqual(before);
  });

  it('never folds a row with no usable timestamp', () => {
    // `entry.at < since` is false for a missing one, so the row counts against
    // every window. Folding it under a real stamp would let one drop it.
    const bulk = filler();
    const undated = { ...row({ amount: '4200' }), at: undefined } as unknown as X402LogEntry;
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, undated, ...tail()]);

    compactX402Log([cut], PAYER_A);

    expect(readX402Log().some((entry) => entry.amount === '4200' && entry.kind === undefined)).toBe(true);
    expect(sumSpentSince(readX402Log(), { payer: PAYER_A }, cut)).toBeGreaterThanOrEqual(4200n);
  });

  it('never folds a checkpoint whose own figure cannot be read', () => {
    // Folding it reads its figure as zero and buries what it stood for inside a
    // fold that no longer looks broken. It has to keep stopping payments.
    const bulk = filler();
    const broken = { ...row({ payer: PAYER_B }), kind: 'checkpoint', folded: 900, amount: 'nope' } as X402LogEntry;
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, broken, ...tail()]);

    compactX402Log([cut], PAYER_A);

    expect(() => sumSpentSince(readX402Log(), { payer: PAYER_B })).toThrow(/unreadable checkpoint covering 900 rows/);
  });

  it('does not rewrite the whole file for a fold that frees almost nothing', () => {
    // Over the threshold the absorbable set does not grow until a window rolls,
    // so without a floor every later payment repeats the read and the rewrite.
    const bulk = filler();
    writeLedger([...bulk, ...tail()]);
    const cut = bulk[1].at;

    compactX402Log([cut], PAYER_A);

    expect(fs.existsSync(PATHS.x402LogArchive)).toBe(false);
    expect(readX402Log().some((entry) => entry.kind === 'checkpoint')).toBe(false);
  });

  it('moves the absorbed rows to the archive and out of the ledger', () => {
    const bulk = filler();
    const absorbed = row({ url: 'https://absorbed.example', amount: '900' });
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, absorbed, ...tail()]);

    compactX402Log([cut], PAYER_A);

    expect(readX402Log().some((entry) => entry.url === 'https://absorbed.example')).toBe(false);
    const archived = fs.readFileSync(PATHS.x402LogArchive, 'utf-8');
    expect(archived).toContain('https://absorbed.example');
    expect(archived.startsWith('\n')).toBe(true);
  });

  it('keeps the ledger 0600, newline-prefixed, and appendable', () => {
    const bulk = filler();
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, ...tail()]);

    compactX402Log([cut], PAYER_A);

    const raw = fs.readFileSync(PATHS.x402Log, 'utf-8');
    expect(fs.statSync(PATHS.x402Log).mode & 0o777).toBe(0o600);
    expect(raw.startsWith('\n')).toBe(true);
    expect(raw.endsWith('\n')).toBe(false);

    appendX402Log(row({ url: 'https://after.example' }));
    expect(readX402Log().at(-1)?.url).toBe('https://after.example');
  });

  it('drops the rewrite when the ledger grew while it was working', () => {
    const bulk = filler();
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, ...tail()]);
    const rowsBefore = readX402Log().length;

    // Stand in for a stale-broken lock: another writer lands its row after the
    // snapshot was taken. Its record must survive, so the rewrite is dropped.
    hooks.afterWrite = () => {
      fs.appendFileSync(PATHS.x402Log, '\n' + JSON.stringify(row({ url: 'https://raced.example' })));
    };

    compactX402Log([cut], PAYER_A);

    const after = readX402Log();
    expect(after.some((entry) => entry.url === 'https://raced.example')).toBe(true);
    expect(after.some((entry) => entry.kind === 'checkpoint')).toBe(false);
    expect(after.length).toBe(rowsBefore + 1);
    expect(fs.readdirSync(TEST_ROOT).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('archives nothing when it drops the rewrite', () => {
    const bulk = filler();
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, ...tail()]);
    hooks.afterWrite = () => {
      fs.appendFileSync(PATHS.x402Log, '\n' + JSON.stringify(row({ url: 'https://raced.example' })));
    };

    compactX402Log([cut], PAYER_A);

    // The rows are still in the ledger, so an archive copy stands for nothing
    // and the next fold that goes through would write them a second time.
    expect(fs.existsSync(PATHS.x402LogArchive)).toBe(false);
  });

  it('refuses to spend against a checkpoint whose figure will not parse', () => {
    writeLedger([
      row({ amount: '100' }),
      { ...row(), kind: 'checkpoint', folded: 812, amount: 'not-a-number' } as X402LogEntry,
    ]);

    expect(() => sumSpentSince(readX402Log(), { payer: PAYER_A })).toThrow(/unreadable checkpoint covering 812 rows/);
  });

  // A reconciliation answers a payment on a line of its own, and the rewrite is
  // where both lines stop existing. The checkpoint has to carry the figure the
  // answer settled on, not the ceiling the payment was counting before it.
  it('folds the figure a settlement correction settled on', () => {
    const bulk = filler();
    const paid = row({
      permissionId: PERM_A,
      amount: '1500',
      authorized: '9000',
      nonce: '0xfeed',
      settlement: 'unverified',
    });
    const cut = new Date(clock + 1000).toISOString();
    writeLedger([...bulk, paid, ...tail()]);
    fs.appendFileSync(
      PATHS.x402Log,
      '\n' + JSON.stringify({ at: at(), corrects: '0xfeed', settlement: 'verified', amount: '400' })
    );

    const scope = { permissionId: PERM_A, payer: PAYER_A };
    // 400 from the corrected payment, plus the 1 each row in the tail carries.
    const before = figures(scope, [undefined]);
    expect(before).toEqual([['620', '0']]);

    compactX402Log([cut], PAYER_A);

    expect(figures(scope, [undefined])).toEqual(before);
    expect(readX402Log().some((entry) => entry.nonce === '0xfeed')).toBe(false);
    expect(fs.readFileSync(PATHS.x402Log, 'utf-8')).not.toContain('corrects');
  });
});

describe('compactX402Log, rows the chain has not answered', () => {
  /**
   * A correction finds its row by nonce, and a checkpoint carries none. Folding
   * an unverified row away makes the ceiling it is holding permanent: the answer
   * still arrives and lands on nothing.
   */
  it('leaves an unverified row in the ledger and folds the rest', () => {
    const pending = row({ nonce: '0xpending', settlement: 'unverified', amount: '5000', scheme: 'upto' });
    writeLedger([...filler(), pending, ...Array.from({ length: 600 }, () => row())]);

    compactX402Log([], PAYER_A);

    const after = readX402Log();
    expect(after.some((entry) => entry.nonce === '0xpending')).toBe(true);
    expect(after.some((entry) => entry.kind === 'checkpoint')).toBe(true);
  });
});

describe('compactX402Log, a checkpoint folded into a later one', () => {
  it('carries the rows it already stood in for', () => {
    writeLedger([...filler(), ...Array.from({ length: 600 }, () => row())]);
    compactX402Log([], PAYER_A);
    const first = readX402Log().find((entry) => entry.kind === 'checkpoint');
    expect(first?.folded).toBeGreaterThan(1);

    // A second pass folds that checkpoint in with everything after it.
    appendX402Log(row());
    fs.appendFileSync(PATHS.x402Log, serialize(filler()));
    compactX402Log([], PAYER_A);

    const second = readX402Log().find((entry) => entry.kind === 'checkpoint');
    expect(second?.folded).toBeGreaterThanOrEqual(first?.folded ?? 0);
  });
});

describe('compactX402Log, a row that was given up on', () => {
  /**
   * The other half of abandoning a row: an unverified one is kept out of the
   * fold because a correction finds it by nonce and a checkpoint has none. Once
   * nothing is going to ask again, that reason is gone and the row may be
   * folded like any other.
   */
  it('folds an abandoned row away', () => {
    const stuck = row({ nonce: '0xstuck', settlement: 'abandoned', amount: '5000' });
    writeLedger([...filler(), stuck, ...Array.from({ length: 600 }, () => row())]);

    compactX402Log([], PAYER_A);

    expect(readX402Log().some((entry) => entry.nonce === '0xstuck')).toBe(false);
  });
});
