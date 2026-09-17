import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * Pins that `jaw x402 log` asks the chain before it prints. The reconciliation
 * itself is tested in `settlement.test.ts`; what was missing here is the call:
 * only `status` and the pay paths made it, so a failed attempt kept its ceiling
 * on screen however long ago the chain had answered for it.
 */

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-log-cmd-test');

vi.mock('../../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-log-cmd-test');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});

const readContract = vi.fn();
vi.mock('../../x402/balance.js', () => ({
  publicClientFor: () => ({ readContract, getTransactionReceipt: vi.fn() }),
}));

const { appendX402Log } = await import('../../x402/ledger.js');
const { default: X402Log } = await import('./log.js');

const NONCE = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

beforeEach(() => {
  delete process.env.JAW_OUTPUT;
  readContract.mockReset();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  // A failed `exact` attempt whose authorization has expired: signed and sent,
  // no receipt, and the chain has had the answer since its deadline.
  appendX402Log({
    at: new Date().toISOString(),
    url: 'https://api.example.com/tool',
    payer: '0x1111111111111111111111111111111111111111',
    status: 'failed',
    amount: '5000',
    authorized: '5000',
    scheme: 'exact',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    network: 'eip155:84532',
    payTo: '0x2222222222222222222222222222222222222222',
    nonce: NONCE,
    deadline: String(Math.floor(Date.now() / 1000) - 60),
    reason: 'settlement failed with status 400',
    settlement: 'unverified',
  });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

async function runLog(argv: string[] = []): Promise<string> {
  const cmd = new X402Log(argv, oclifConfig);
  const lines: string[] = [];
  Object.assign(cmd, {
    log: (message?: string) => {
      lines.push(String(message ?? ''));
    },
  });
  await cmd.run();
  return lines.join('\n');
}

describe('jaw x402 log', () => {
  it('frees the ceiling of an expired authorization before printing it', async () => {
    // The token never consumed the nonce, so nothing moved.
    readContract.mockResolvedValue(false);

    const out = await runLog();

    expect(out).toContain('0 USDC');
    expect(out).toContain('0 USDC out');
    expect(out).not.toContain('0.005 USDC');
  });

  it('says on the row that the chain settled a payment the server refused', async () => {
    readContract.mockResolvedValue(true);

    const out = await runLog();

    expect(out).toContain('settled on chain; the resource never arrived');
    expect(out).toContain('0.005 USDC out');
  });

  it('prints the reconciled figure in json too', async () => {
    readContract.mockResolvedValue(false);

    const parsed = JSON.parse(await runLog(['--output', 'json']));

    expect(parsed[0].settlement).toBe('expired');
  });
});
