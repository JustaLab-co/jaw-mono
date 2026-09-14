import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * An allowance that parses but is negative is unusable: `checkPolicy` compares
 * `spent + amount > cap` and refuses every payment against it. The ranking
 * treats it as no room, so it is the limit the verdict is about, and the report
 * has to say so in both renderings.
 *
 * It gets there through the config file, which is read as JSON and cast.
 * `policyFromPermission` drops a negative allowance off the grant, but a limit
 * set under `x402` is merged verbatim and overrides the grant's.
 *
 * Read with a parse rule that lets negatives through, the "cannot be read"
 * warning never fires, and with no usage beside the limit nothing is reported
 * at all: a ready verdict for a session that cannot pay.
 */

const h = vi.hoisted(() => {
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
    config: {
      x402: {
        perPeriod: [
          {
            allowance: '-5000000',
            unit: 'day' as const,
            multiplier: 1,
            anchor: new Date(Date.now() - 3600_000).toISOString(),
          },
        ],
      },
    },
  };
});

vi.mock('../../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-status-negative-allowance');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});
vi.mock('../../lib/keystore.js', () => ({ keystoreExists: () => true }));
vi.mock('../../lib/config.js', () => ({ loadConfig: () => h.config, ensureDir: () => undefined }));
vi.mock('../../lib/session-config.js', () => ({
  tryLoadSessionConfig: () => h.session,
  isLegacySession: () => false,
  liveOrphans: () => [],
}));
vi.mock('../../x402/payer.js', () => ({ sessionPayerAddress: () => h.payer }));
vi.mock('../../x402/balance.js', () => ({ usdcBalance: async () => ({ formatted: '20' }) }));
vi.mock('../../x402/ledger.js', () => ({ readX402Log: () => [], sumSpentSince: () => 0n, sumToppedUpSince: () => 0n }));
// The unreadable anchor case: `currentLimitUsage` drops a limit it cannot
// window, so the limit reaches the report with no usage beside it.
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

describe('jaw x402 status, an allowance that parses negative', () => {
  it('refuses the ready verdict and names the allowance as unreadable', async () => {
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.ready).toBe(false);
    expect(report.problems).toContainEqual(expect.stringMatching(/allowance for this day cannot be read/));
  });

  it('says the same thing in the human rendering', async () => {
    const lines = (await runStatus([])).join('\n');
    expect(lines).toMatch(/cannot be read/);
  });
});
