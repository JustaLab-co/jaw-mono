import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * A limit the policy holds but whose usage could not be computed is still
 * enforced by `checkPolicy`. Deriving the report from the usage list instead of
 * from the policy made it invisible: no line, no json entry, and a ready
 * verdict for a session whose grant is the thing bounding it.
 *
 * The usage read is stubbed empty here because every path that drops a limit is
 * defensive, so the divergence cannot be produced through the front door. What
 * is under test is that the report and the enforcement read the same source.
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
        spends: [{ token: USDC, allowance: '5000000', unit: 'day', multiplier: 1 }],
      },
    },
  };
});

vi.mock('../../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-status-unmeasured');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});
vi.mock('../../lib/keystore.js', () => ({ keystoreExists: () => true }));
vi.mock('../../lib/config.js', () => ({ loadConfig: () => ({}), ensureDir: () => undefined }));
vi.mock('../../lib/session-config.js', () => ({
  expiryInstant: (expiry: unknown) =>
    typeof expiry === 'number' && Number.isFinite(expiry) ? new Date(expiry * 1000) : null,
  tryLoadSessionConfig: () => h.session,
  isLegacySession: () => false,
  liveOrphans: () => [],
}));
vi.mock('../../x402/payer.js', () => ({ sessionPayerAddress: () => h.payer }));
vi.mock('../../x402/balance.js', () => ({ usdcBalance: async () => ({ formatted: '20' }) }));
vi.mock('../../x402/ledger.js', () => ({ readX402Log: () => [], sumSpentSince: () => 0n, sumToppedUpSince: () => 0n }));
// The whole point: the policy holds a limit and no usage came back for it.
vi.mock('../../x402/spend-window.js', () => ({ currentLimitUsageOnChain: async () => [] }));

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

describe('jaw x402 status, a limit with no usage', () => {
  it('still reports it, and names the figure as missing rather than printing a zero', async () => {
    const lines = (await runStatus([])).join('\n');
    expect(lines).toMatch(/\? of 5 USDC used this day \(usage unknown\)/);
  });

  it('still lists it in the json, with the missing figures null', async () => {
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.policy.perPeriod).toEqual([
      { allowance: '5000000', unit: 'day', multiplier: 1, used: null, usedFrom: 'unmeasured', resetsAt: null },
    ]);
  });

  /**
   * The zero an unmeasured limit carries must not reach `diagnose` as if it
   * were a reading: comparing it against a full cap says "plenty left" about a
   * figure nobody read.
   *
   * The verdict stays ready. A setup whose usage cannot be read is not a broken
   * setup, and the chain still enforces; what would be wrong is claiming the
   * allowance is untouched. The report says the figure is unknown in both
   * renderings, which is the honest version of not knowing.
   */
  it('does not let the unknown figure read as an untouched allowance', async () => {
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.problems).not.toContain(expect.stringMatching(/allowance/));
    expect(report.policy.perPeriod[0].used).toBeNull();
    expect(report.ready).toBe(true);
  });
});
