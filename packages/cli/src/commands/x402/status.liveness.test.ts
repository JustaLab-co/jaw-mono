import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * Pins what `jaw x402 status` does with the one fact the local file cannot
 * hold. Expiry is already on disk, so a revoke made from keys.jaw.id or from
 * another machine was the case where every local surface reported a healthy
 * session that could no longer pull anything through its permission.
 *
 * The read itself is mocked. What is under test is the wiring: that a revoked
 * permission reaches the verdict a script reads, and that not knowing is never
 * rendered as dead.
 */

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-status-liveness-test');

const h = vi.hoisted(() => ({
  payer: '0x1111111111111111111111111111111111111111' as const,
  liveness: { value: 'unknown' as string },
  session: {
    ownerAddress: '0x2222222222222222222222222222222222222222',
    sessionAddress: '0x1111111111111111111111111111111111111111',
    permissionId: '0xabc',
    chainId: 84532,
    expiry: Math.floor(Date.now() / 1000) + 6 * 86400,
    createdAt: new Date().toISOString(),
    mode: 'eip7702' as const,
  },
}));

vi.mock('../../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-status-liveness-test');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});

vi.mock('../../lib/keystore.js', () => ({ keystoreExists: () => true }));
vi.mock('../../lib/config.js', () => ({
  loadConfig: () => ({}),
  ensureDir: (dir: string) => {
    require('node:fs').mkdirSync(dir, { recursive: true });
  },
}));
vi.mock('../../lib/session-config.js', () => ({
  expiryInstant: (expiry: unknown) =>
    typeof expiry === 'number' && Number.isFinite(expiry) ? new Date(expiry * 1000) : null,
  tryLoadSessionConfig: () => h.session,
  isLegacySession: () => false,
  liveOrphans: () => [],
}));
vi.mock('../../x402/payer.js', () => ({ sessionPayerAddress: () => h.payer }));
vi.mock('../../x402/balance.js', () => ({ usdcBalance: async () => ({ formatted: '20' }) }));
vi.mock('../../x402/permission-onchain.js', () => ({ readLiveness: async () => h.liveness.value }));

const { default: X402Status } = await import('./status.js');

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

beforeEach(() => {
  delete process.env.JAW_OUTPUT;
  delete process.env.JAW_CHAIN_ID;
  delete process.env.JAW_API_KEY;
  h.liveness.value = 'unknown';
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

async function runStatus(argv: string[]): Promise<string[]> {
  const cmd = new X402Status(argv, oclifConfig);
  const lines: string[] = [];
  Object.assign(cmd, {
    log: (message?: string) => {
      lines.push(String(message ?? ''));
    },
  });
  await cmd.run();
  return lines;
}

describe('jaw x402 status, on-chain liveness', () => {
  it('refuses to call a revoked permission ready, though the local expiry is days away', async () => {
    h.liveness.value = 'revoked';
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));

    expect(report.expired).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.permission).toEqual({ id: '0xabc', onChain: 'revoked' });
    expect(report.problems.join(' ')).toMatch(/revoked on chain/i);
  });

  it('says so on the permission line in the human report', async () => {
    h.liveness.value = 'revoked';
    const lines = await runStatus([]);
    expect(lines.join('\n')).toMatch(/perm\s+0xabc\s+REVOKED on chain/);
  });

  /**
   * The case that must not become a false alarm. A node that did not answer, a
   * session written before the struct was stored, and a chain with no client
   * all arrive here as `unknown`.
   */
  it('stays quiet, and stays ready, when the chain could not be asked', async () => {
    const lines = await runStatus([]);
    expect(lines.join('\n')).not.toMatch(/perm\s/);

    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.permission).toEqual({ id: '0xabc', onChain: 'unknown' });
    expect(report.problems).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('reports a permission the chain has no approval for', async () => {
    h.liveness.value = 'unapproved';
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.ready).toBe(false);
    expect(report.problems.join(' ')).toMatch(/no record of this permission being approved/);
  });

  /**
   * A struct that does not hash to the granted id means the chain cannot be
   * asked about this permission, and nothing more: the caps still apply and
   * payments still go through. Reporting it as a blocker stopped agents paying
   * against a healthy session over a local serialisation issue.
   */
  it('says a stored permission does not match without calling the session unready', async () => {
    h.liveness.value = 'mismatch';
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.permission.onChain).toBe('mismatch');
    expect(report.ready).toBe(true);
    expect(report.problems).toEqual([]);

    const lines = await runStatus([]);
    expect(lines.join('\n')).toMatch(/does not match the stored permission/);
  });
});
