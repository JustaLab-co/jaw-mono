import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-config-set-test');

vi.mock('../../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-config-set-test');
  return { PATHS: { root, config: p.join(root, 'config.json') } };
});

const { default: ConfigSet } = await import('./set.js');

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

beforeEach(() => {
  delete process.env.JAW_OUTPUT;
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

async function runSet(argv: string[]): Promise<unknown> {
  const cmd = new ConfigSet(argv, oclifConfig);
  cmd.log = () => undefined;
  return await cmd.run();
}

describe('jaw config set', () => {
  it('writes an x402 amount that validates', async () => {
    await runSet(['x402.maxAmountPerPayment=50000']);

    const written = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'config.json'), 'utf-8'));
    expect(written.x402.maxAmountPerPayment).toBe('50000');
  });

  // The setter rejects a non-integer amount by throwing, so the x402 branch has
  // to call it inside the same guard its neighbour has. Outside it, the user
  // gets a stack trace where the same mistake on `defaultChain` prints one line.
  it('reports a rejected x402 amount the way the rest of the command does', async () => {
    const err = (await runSet(['x402.maxAmountPerPayment=abc']).catch((e) => e)) as Error & {
      oclif?: { exit?: number };
    };

    expect(err.oclif).toBeDefined();
    expect(err.message).toContain('non-negative integer');
  });
});
