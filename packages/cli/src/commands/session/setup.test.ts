import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * The grant ceiling is a local refusal, and it has to run before the block that
 * revokes the existing permission on chain. The other way round, a `--limit`
 * over the ceiling costs the user the permission they already had and leaves
 * them with none: the revoke has happened and the new grant never will.
 *
 * That is the property worth pinning, and it is invisible to a diff: nothing
 * about either line is wrong, only which one comes first.
 */

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const h = vi.hoisted(() => ({
  config: { apiKey: 'k' } as Record<string, unknown>,
  existing: null as Record<string, unknown> | null,
  hasKeystore: false,
  saved: null as Record<string, unknown> | null,
  bridges: 0,
  requests: [] as string[],
  stderr: [] as string[],
  answers: [] as string[],
}));

vi.mock('../../lib/config.js', () => ({ loadConfig: () => h.config }));

// The destructive path is the interactive one: answering yes to "Revoke old
// permission on-chain first?" opens a bridge and revokes before anything else
// happens. `--yes` never revokes, so a test driven through it cannot tell the
// two orderings apart, which is how the first version of this file passed
// against both.
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(h.answers.shift() ?? ''),
    close: () => undefined,
  }),
}));

vi.mock('../../lib/keystore.js', () => ({
  keystoreExists: () => h.hasKeystore,
  generateSessionKey: () => '0x' + '11'.repeat(32),
  loadSessionKey: () => '0x' + '11'.repeat(32),
  tryLoadKeystoreAddress: () => '0x2222222222222222222222222222222222222222',
  saveKeystore: () => undefined,
}));

vi.mock('../../lib/session-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/session-config.js')>()),
  tryLoadSessionConfig: () => h.existing,
  saveSessionConfig: (config: Record<string, unknown>) => {
    h.saved = config;
  },
}));

// Every on-chain effect this command can have goes through a bridge, so
// counting them is how "nothing was touched" gets asserted.
vi.mock('../../lib/bridge-singleton.js', () => ({
  getBridge: async () => {
    h.bridges += 1;
    return {
      request: async (method: string) => {
        h.requests.push(method);
        if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111'];
        if (method === 'wallet_grantPermissions') {
          return {
            account: '0x1111111111111111111111111111111111111111',
            spender: '0x2222222222222222222222222222222222222222',
            start: 1_756_000_000,
            end: 1_756_604_800,
            salt: '0xabc',
            calls: [{ target: USDC, selector: '0xa9059cbb' }],
            spends: [{ token: USDC, allowance: '0x989680', unit: 'day', multiplier: 1 }],
            permissionId: '0xnew',
            chainId: '0x14a34',
          };
        }
        return {};
      },
      close: () => undefined,
    };
  },
}));

vi.mock('../../x402/funded-owner.js', () => ({
  whyOwnerCannotFundSession: async () => null,
  whySpenderCannotPay: async () => null,
}));

vi.mock('@jaw.id/core', () => ({
  Account: {
    fromLocalAccount: async () => ({ address: '0x2222222222222222222222222222222222222222' }),
  },
}));

const { default: SessionSetup } = await import('./setup.js');

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

beforeEach(() => {
  delete process.env.JAW_OUTPUT;
  delete process.env.JAW_CHAIN_ID;
  process.env.JAW_API_KEY = 'k';
  h.config = { apiKey: 'k' };
  h.existing = null;
  h.hasKeystore = false;
  h.saved = null;
  h.bridges = 0;
  h.requests = [];
  h.stderr = [];
  h.answers = [];
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

async function runSetup(argv: string[]): Promise<string[]> {
  const cmd = new SessionSetup(argv, oclifConfig);
  const lines: string[] = [];
  Object.assign(cmd, {
    log: (message?: string) => {
      lines.push(String(message ?? ''));
    },
    logToStderr: (message?: string) => {
      h.stderr.push(String(message ?? ''));
    },
  });
  await cmd.run();
  return lines;
}

const activeSession = () => ({
  ownerAddress: '0x1111111111111111111111111111111111111111',
  sessionAddress: '0x2222222222222222222222222222222222222222',
  permissionId: '0xold',
  chainId: 84532,
  expiry: Math.floor(Date.now() / 1000) + 6 * 86400,
  createdAt: new Date().toISOString(),
  mode: 'eip7702' as const,
});

describe('jaw session setup', () => {
  /**
   * The one the reorder exists for. Everything the check needs is known before
   * the command touches anything, so a refusal must not cost the permission
   * already in hand.
   */
  it('refuses a grant over the ceiling without touching the existing one', async () => {
    h.config = { apiKey: 'k', grantCeiling: '5/day' };
    h.hasKeystore = true;
    h.existing = activeSession();
    // Yes to revoking the old permission, which is what makes this the
    // destructive path and the only one that tells the two orderings apart.
    h.answers = ['y', 'y'];

    await expect(runSetup(['--x402', '--limit', '50/day', '--chain', '84532'])).rejects.toThrow(
      /over the 5\/day ceiling/
    );

    expect(h.bridges).toBe(0);
    expect(h.requests).toEqual([]);
    expect(h.saved).toBeNull();
  });

  // The counterpart, so the test above is known to be exercising a path that
  // really does revoke rather than one that never would.
  it('does revoke on that path when the grant is allowed', async () => {
    h.hasKeystore = true;
    h.existing = activeSession();
    h.answers = ['y', 'y'];

    await runSetup(['--x402', '--chain', '84532', '--quiet']);

    expect(h.requests).toContain('wallet_revokePermissions');
    expect(h.saved?.orphanedPermissions).toBeUndefined();
  });

  it('refuses before the chain even with no session to lose', async () => {
    h.config = { apiKey: 'k', grantCeiling: '5/day' };
    await expect(runSetup(['--x402', '--limit', '50/day', '--chain', '84532'])).rejects.toThrow(/ceiling/);
    expect(h.bridges).toBe(0);
  });

  it('grants when the limit is within the ceiling', async () => {
    h.config = { apiKey: 'k', grantCeiling: '5/day' };
    await runSetup(['--x402', '--limit', '5/day', '--chain', '84532', '--quiet']);
    expect(h.requests).toContain('wallet_grantPermissions');
    expect(h.saved?.permissionId).toBe('0xnew');
  });

  /**
   * The struct is what every on-chain read is built from, and the response
   * carries it. Narrowing it away here is what left the CLI holding the one
   * field no view on the manager accepts.
   */
  it('stores the permission struct the grant returned', async () => {
    await runSetup(['--x402', '--chain', '84532', '--quiet']);
    expect(h.saved?.permission).toMatchObject({ salt: '0xabc', start: 1_756_000_000 });
    // And nothing else describing the same grant: the policy is derived from
    // this struct on read, so there is no second copy to fall out of step.
    expect(h.saved).not.toHaveProperty('grantedSpend');
  });

  /**
   * `--yes` never revokes, and the session key is not reused there either, so
   * what is left behind is a live grant on the account. Recording its id is the
   * only thing that keeps `session revoke` able to reach it.
   */
  it('records the permission it leaves live under --yes', async () => {
    h.hasKeystore = true;
    h.existing = activeSession();

    await runSetup(['--x402', '--chain', '84532', '--yes', '--quiet']);

    expect(h.saved?.orphanedPermissions).toEqual([{ id: '0xold', chainId: 84532, expiry: h.existing.expiry }]);
    expect(h.stderr.join(' ')).toMatch(/remains live/);
    expect(h.requests).not.toContain('wallet_revokePermissions');
  });

  it('refuses --limit without --x402, which would silently do nothing', async () => {
    await expect(runSetup(['--limit', '10/day', '--chain', '84532'])).rejects.toThrow(/only applies to --x402/);
    expect(h.bridges).toBe(0);
  });
});
