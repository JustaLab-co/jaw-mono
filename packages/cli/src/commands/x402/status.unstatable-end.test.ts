import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * A limit the chain metered, over a window whose end nobody can state: what a
 * permission granted with no end leaves behind. The figure is known and the
 * reset date is not, and reading the missing date as a missing figure hid a
 * drained allowance behind a ready verdict.
 */

const h = vi.hoisted(() => {
  // Declared inside: the factory is hoisted above any const beside it, so a
  // reference to one throws only once another file in the run gets there first.
  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  return {
    payer: '0x1111111111111111111111111111111111111111' as const,
    session: {
      ownerAddress: '0x2222222222222222222222222222222222222222',
      sessionAddress: '0x1111111111111111111111111111111111111111',
      permissionId: '0xabc',
      chainId: 84532,
      expiry: Math.floor(Date.now() / 1000) + 6 * 86400,
      createdAt: new Date().toISOString(),
      mode: 'eip7702' as const,
      permission: {
        account: '0x2222222222222222222222222222222222222222',
        spender: '0x1111111111111111111111111111111111111111',
        start: Math.floor(Date.now() / 1000) - 3600,
        end: Math.floor(Date.now() / 1000) + 6 * 86400,
        salt: '0xabc',
        calls: [{ target: USDC, selector: '0xa9059cbb' }],
        spends: [{ token: USDC, allowance: '5000000', unit: 'forever', multiplier: 1 }],
      },
    },
  };
});

vi.mock('../../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-status-unstatable-end');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});
vi.mock('../../lib/keystore.js', () => ({ keystoreExists: () => true }));
vi.mock('../../lib/config.js', () => ({ loadConfig: () => ({}), ensureDir: () => undefined }));
vi.mock('../../lib/session-config.js', () => ({
  sessionUsable: (expiry: unknown, now: number = Date.now() / 1000) =>
    typeof expiry === 'number' && Number.isFinite(expiry) && expiry > now,
  expiryInstant: (expiry: unknown) =>
    typeof expiry === 'number' && Number.isFinite(expiry) ? new Date(expiry * 1000) : null,
  tryLoadSessionConfig: () => h.session,
  isLegacySession: () => false,
  liveOrphans: () => [],
}));
vi.mock('../../x402/payer.js', () => ({ sessionPayerAddress: () => h.payer }));
vi.mock('../../x402/balance.js', () => ({ usdcBalance: async () => ({ formatted: '20' }) }));
vi.mock('../../x402/ledger.js', () => ({ readX402Log: () => [], sumSpentSince: () => 0n, sumToppedUpSince: () => 0n }));
// Metered by the chain, counted from a start we have, ending nowhere we can name.
vi.mock('../../x402/spend-window.js', () => ({
  currentLimitUsageOnChain: async () => [
    {
      allowance: '5000000',
      // `forever` is the only unit whose window ends where the permission does,
      // so it is the only one that can reach this with no end to name.
      unit: 'forever',
      multiplier: 1,
      anchor: new Date().toISOString(),
      spent: 5_000_000n,
      toppedUp: 5_000_000n,
      startedAt: new Date(),
      endsAt: null,
      source: 'chain' as const,
    },
  ],
}));

const { default: X402Status } = await import('./status.js');

let oclifConfig: Config;

beforeAll(async () => {
  oclifConfig = await Config.load({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..') });
});

beforeEach(() => {
  delete process.env.JAW_OUTPUT;
  delete process.env.JAW_CHAIN_ID;
  delete process.env.JAW_API_KEY;
});

async function runStatus(argv: string[]): Promise<string[]> {
  const cmd = new X402Status(argv, oclifConfig);
  const lines: string[] = [];
  Object.assign(cmd, { log: (m?: string) => lines.push(String(m ?? '')) });
  await cmd.run();
  return lines;
}

describe('jaw x402 status, a limit whose window has no end to name', () => {
  it('reports the figure the chain metered rather than calling it unknown', async () => {
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));

    expect(report.policy.perPeriod).toEqual([
      { allowance: '5000000', unit: 'forever', multiplier: 1, used: '5000000', usedFrom: 'chain', resetsAt: null },
    ]);
  });

  // The failure this guards: the drained cap read as unknown, so nothing was
  // said about it and the session answered ready to an agent that cannot pay.
  it('still says the allowance is used up', async () => {
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));

    expect(report.ready).toBe(false);
    expect(report.problems.join(' ')).toMatch(/allowance for the whole permission is used up/);
    // It never resets, so nothing may tell the reader to wait for a window.
    expect(report.problems.join(' ')).not.toMatch(/resets at the end/);
  });

  it('prints the figure with no reset date instead of a question mark', async () => {
    const lines = (await runStatus([])).join('\n');

    expect(lines).toMatch(/5 USDC of 5 USDC used the whole permission/);
    expect(lines).not.toMatch(/usage unknown/);
  });
});
