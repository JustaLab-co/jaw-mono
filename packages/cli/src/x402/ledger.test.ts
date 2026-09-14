import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-ledger-test');

vi.mock('../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-ledger-test');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});

const { appendX402Log, appendX402Correction, readX402Log } = await import('./ledger.js');
const { PATHS } = await import('../lib/paths.js');

const entry = (over: Partial<Parameters<typeof appendX402Log>[0]> = {}) => ({
  at: '2026-07-16T00:00:00.000Z',
  url: 'https://api.example.com/x',
  payer: '0x0000000000000000000000000000000000000001',
  status: 'paid' as const,
  amount: '1000',
  ...over,
});

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('x402 ledger', () => {
  it('returns an empty log when the file is missing', () => {
    expect(readX402Log()).toEqual([]);
  });

  it('appends entries and reads them back oldest-first', () => {
    appendX402Log(entry({ url: 'https://a' }));
    appendX402Log(entry({ url: 'https://b', status: 'failed', reason: 'insufficient_balance' }));
    const log = readX402Log();
    expect(log).toHaveLength(2);
    expect(log[0].url).toBe('https://a');
    expect(log[1]).toMatchObject({ url: 'https://b', status: 'failed', reason: 'insufficient_balance' });
  });

  it('limit returns only the most recent N', () => {
    for (let i = 0; i < 5; i++) appendX402Log(entry({ url: `https://${i}` }));
    const last2 = readX402Log(2);
    expect(last2.map((e) => e.url)).toEqual(['https://3', 'https://4']);
  });

  it('skips malformed lines without throwing', () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.writeFileSync(
      PATHS.x402Log,
      `${JSON.stringify(entry())}\nnot-json\n${JSON.stringify(entry({ url: 'https://ok' }))}\n`
    );
    const log = readX402Log();
    expect(log).toHaveLength(2);
    expect(log[1].url).toBe('https://ok');
  });

  it('writes the ledger file 0600', () => {
    appendX402Log(entry());
    const mode = fs.statSync(PATHS.x402Log).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('a torn line does not swallow the next entry (newline-prefixed appends)', () => {
    // Simulate a crash mid-append: an incomplete record with no surrounding
    // newlines. The next append must land on its own line, so only the torn
    // record is lost — not the good one after it.
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.writeFileSync(PATHS.x402Log, `${JSON.stringify(entry({ url: 'https://good1' }))}\n{"at":"partial`);

    appendX402Log(entry({ url: 'https://good2' }));

    const log = readX402Log();
    const urls = log.map((e) => e.url);
    expect(urls).toContain('https://good1');
    expect(urls).toContain('https://good2'); // survived despite the torn line before it
    expect(urls).not.toContain(undefined);
  });

  it('folds a correction onto the payment it answers, and hides the correction itself', () => {
    appendX402Log(entry({ nonce: '7', authorized: '1000', settlement: 'unverified' }));
    appendX402Correction({ at: '2026-07-16T01:00:00.000Z', corrects: '7', settlement: 'verified', amount: '400' });

    const log = readX402Log();

    expect(log).toHaveLength(1);
    expect(log[0].settlement).toBe('verified');
    expect(log[0].amount).toBe('400');
  });

  it('takes the last answer about a nonce', () => {
    appendX402Log(entry({ nonce: '7', settlement: 'unverified' }));
    appendX402Correction({ at: '2026-07-16T01:00:00.000Z', corrects: '7', settlement: 'expired', amount: '0' });
    appendX402Correction({ at: '2026-07-16T02:00:00.000Z', corrects: '7', settlement: 'verified', amount: '400' });

    expect(readX402Log()[0].settlement).toBe('verified');
  });

  it('counts the limit in payments, not in lines', () => {
    appendX402Log(entry({ url: 'https://a', nonce: '1' }));
    appendX402Log(entry({ url: 'https://b', nonce: '2' }));
    appendX402Correction({ at: '2026-07-16T01:00:00.000Z', corrects: '1', settlement: 'verified', amount: '5' });

    expect(readX402Log(2).map((e) => e.url)).toEqual(['https://a', 'https://b']);
  });

  it('skips a line that parses to something that is not a record', () => {
    appendX402Log(entry({ url: 'https://good' }));
    fs.appendFileSync(PATHS.x402Log, '\nnull');
    fs.appendFileSync(PATHS.x402Log, '\n42');
    appendX402Log(entry({ url: 'https://after' }));

    expect(readX402Log().map((e) => e.url)).toEqual(['https://good', 'https://after']);
  });
});
