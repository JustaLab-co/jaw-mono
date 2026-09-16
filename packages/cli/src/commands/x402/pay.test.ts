import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * The terminal half of the payment path. Both front ends now open the same
 * window, and this pins the wiring on the side that has no other coverage: the
 * MCP tool is exercised by `mcp/server.test.ts`, this command by nothing.
 *
 * What it guards is the seam the extraction left behind. The command decides
 * twice whether this is a rehearsal, once for the window and once for the
 * payment, and the two have to say the same thing. A window opened dry under a
 * real payment builds no funding hook, so a short payer fails on a bare
 * insufficient-balance error from the token, with no warning that a refill was
 * never on the table.
 */

const h = vi.hoisted(() => ({
  payer: '0x1111111111111111111111111111111111111111' as const,
  config: { x402: { topUpFloat: '5000000' } } as Record<string, unknown>,
  session: {
    ownerAddress: '0x2222222222222222222222222222222222222222',
    sessionAddress: '0x1111111111111111111111111111111111111111',
    permissionId: '0xabc',
    chainId: 84532,
    expiry: Math.floor(Date.now() / 1000) + 86400,
    createdAt: '2026-09-01T00:00:00.000Z',
  } as Record<string, unknown> | null,
  apiKey: 'key' as string | undefined,
  windowInputs: [] as Record<string, unknown>[],
  ensureFunds: vi.fn(),
  periodUsage: [] as unknown[],
  payOpts: [] as Record<string, unknown>[],
  outcome: {} as Record<string, unknown>,
  appended: [] as Record<string, unknown>[],
  compactions: [] as string[][],
  locked: 0,
}));

vi.mock('../../lib/config.js', () => ({ loadConfig: () => h.config }));
vi.mock('../../lib/api-key.js', () => ({ apiKeyFor: () => h.apiKey }));
vi.mock('../../lib/session-config.js', () => ({ tryLoadSessionConfig: () => h.session }));
vi.mock('../../x402/payer.js', () => ({
  Eip3009EoaPayer: { fromSessionKey: () => ({ address: h.payer }) },
}));

vi.mock('../../x402/payment-window.js', () => ({
  openPaymentWindow: async (input: Record<string, unknown>) => {
    h.windowInputs.push(input);
    return {
      spentThisSession: 100_000n,
      periodUsage: h.periodUsage,
      // The window itself decides when there is no hook; here it always hands
      // one back, so a command that drops it is the only way it goes missing.
      ensureFunds: h.ensureFunds,
    };
  },
}));

vi.mock('../../x402/http.js', () => ({
  payAndFetch: async (_url: string, _payer: unknown, opts: Record<string, unknown>) => {
    h.payOpts.push(opts);
    return { payer: h.payer, status: 200, ...h.outcome };
  },
}));

vi.mock('../../x402/ledger.js', () => ({
  appendX402Log: (entry: Record<string, unknown>) => h.appended.push(entry),
  compactX402Log: (starts: string[]) => h.compactions.push(starts),
}));

vi.mock('../../lib/payment-lock.js', () => ({
  withPaymentLock: async <T>(fn: () => Promise<T>) => {
    h.locked += 1;
    return fn();
  },
}));

const { default: X402Pay } = await import('./pay.js');

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

const limit = (startedAt: string) => ({
  allowance: '5000000',
  unit: 'day',
  multiplier: 1,
  anchor: startedAt,
  spent: 0n,
  toppedUp: 0n,
  startedAt: new Date(startedAt),
  endsAt: null,
  source: 'ledger' as const,
});

beforeEach(() => {
  h.config = { x402: { topUpFloat: '5000000' } };
  h.session = {
    ownerAddress: '0x2222222222222222222222222222222222222222',
    sessionAddress: h.payer,
    permissionId: '0xabc',
    chainId: 84532,
    expiry: Math.floor(Date.now() / 1000) + 86400,
    createdAt: '2026-09-01T00:00:00.000Z',
  };
  h.apiKey = 'key';
  h.windowInputs = [];
  h.periodUsage = [];
  h.payOpts = [];
  h.outcome = {};
  h.appended = [];
  h.compactions = [];
  h.locked = 0;
  h.ensureFunds.mockReset();
  delete process.env.JAW_OUTPUT;
  delete process.env.JAW_CHAIN_ID;
  delete process.env.JAW_API_KEY;
});

interface RunResult {
  lines: string[];
  warnings: string[];
  exitCode: number | undefined;
}

async function runPay(argv: string[]): Promise<RunResult> {
  const cmd = new X402Pay(argv, oclifConfig);
  const result: RunResult = { lines: [], warnings: [], exitCode: undefined };
  Object.assign(cmd, {
    log: (message?: string) => result.lines.push(String(message ?? '')),
    warn: (message: string) => result.warnings.push(String(message)),
    exit: (code = 0) => {
      result.exitCode = code;
      // oclif's own `exit` throws to unwind the command; the tests read the
      // code off the result rather than the thrown error.
      throw new Error('exit');
    },
  });
  try {
    await cmd.run();
  } catch (err) {
    if (result.exitCode === undefined) throw err;
  }
  return result;
}

describe('jaw x402 pay', () => {
  it('rehearses by default: same verdict to the window and to the payment', async () => {
    await runPay(['https://api.example.com/tool']);

    expect(h.windowInputs[0]?.dryRun).toBe(true);
    expect(h.payOpts[0]?.dryRun).toBe(true);
    // Nothing spent means nothing recorded, and nothing to queue behind.
    expect(h.appended).toEqual([]);
    expect(h.compactions).toEqual([]);
    expect(h.locked).toBe(0);
  });

  it('spends under one verdict too, and takes the lock to do it', async () => {
    h.outcome = {
      paid: true,
      payment: { amount: '100000', network: 'eip155:84532', payTo: '0x3', authorized: '100000' },
    };

    await runPay(['https://api.example.com/tool', '--pay']);

    expect(h.windowInputs[0]?.dryRun).toBe(false);
    expect(h.payOpts[0]?.dryRun).toBe(false);
    expect(h.locked).toBe(1);
  });

  it('pays against the window it just opened, hook included', async () => {
    h.periodUsage = [limit('2026-09-10T00:00:00.000Z')];

    await runPay(['https://api.example.com/tool', '--pay']);

    // The caps that bound the payment are the ones the window measured, never
    // a second reading: a payment measured against a fresher total than the
    // one the ledger row lands beside is the race the lock exists to close.
    expect(h.payOpts[0]?.spentThisSession).toBe(100_000n);
    expect(h.payOpts[0]?.periodUsage).toBe(h.periodUsage);
    expect(h.payOpts[0]?.ensureFunds).toBe(h.ensureFunds);
  });

  it('reads the refill float off config rather than leaving it to the window', async () => {
    await runPay(['https://api.example.com/tool', '--pay']);

    expect(h.windowInputs[0]).toMatchObject({
      payerAddress: h.payer,
      apiKey: 'key',
      topUpFloat: '5000000',
    });
  });

  it('folds the ledger against the windows this payment measured against', async () => {
    h.periodUsage = [limit('2026-09-10T00:00:00.000Z')];
    h.outcome = {
      paid: true,
      payment: { amount: '100000', network: 'eip155:84532', payTo: '0x3', authorized: '100000' },
    };

    await runPay(['https://api.example.com/tool', '--pay']);

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({ status: 'paid', settlement: 'unverified' });
    // The live cap's own start plus the session's, which are the instants a
    // compaction must not cut across.
    expect(h.compactions[0]).toEqual(['2026-09-10T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
  });

  it('records a refusal and fails the scripting path with it', async () => {
    h.outcome = { status: 402, refusedReason: 'over the per-payment cap' };

    const result = await runPay(['https://api.example.com/tool', '--pay', '--output', 'json']);

    // `--output json` is the mode a wrapper reads, and it was the one reporting
    // success on a payment that never went through.
    expect(result.exitCode).toBe(1);
    expect(h.appended[0]).toMatchObject({ status: 'refused' });
    // A refusal signed nothing, so there is no authorization to count.
    expect(h.appended[0]?.settlement).toBeUndefined();
  });

  it.each([
    ['no api key', { apiKey: undefined }, 'No API key'],
    ['no session', { session: null }, 'No session'],
  ])('says out loud that a short payer cannot be refilled with %s', async (_label, over, expected) => {
    Object.assign(h, over);
    h.outcome = {
      paid: true,
      payment: { amount: '100000', network: 'eip155:84532', payTo: '0x3', authorized: '100000' },
    };

    const result = await runPay(['https://api.example.com/tool', '--pay']);

    // Otherwise the failure arrives later as a bare insufficient-balance error
    // with no hint that a top-up was never on the table.
    expect(result.warnings.join('\n')).toContain(expected);
  });

  it('keeps quiet about a refill it was never going to make in a rehearsal', async () => {
    h.apiKey = undefined;

    const result = await runPay(['https://api.example.com/tool']);

    expect(result.warnings).toEqual([]);
  });
});
