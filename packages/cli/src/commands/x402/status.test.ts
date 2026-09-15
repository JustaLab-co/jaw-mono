import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, hashDomain } from 'viem';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const EIP712_DOMAIN_TYPE = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const;

/**
 * Pins the wiring between the ledger's two meters and what `jaw x402 status`
 * reports. The primitives (`diagnose`, `sumToppedUpSince`) have their own
 * tests; what once regressed was which field this command fed them: the period
 * figure read payments while the on-chain allowance is drawn down by top-ups,
 * so one top-up at the grant's size left the report quiet and `ready: true`
 * while every further refill was already impossible.
 *
 * The scenario is the one from that report: a 5 USDC/day grant, a single
 * 0.1 USDC payment funded by a 5 USDC top-up. The period figure must show the
 * 5 the chain lost, not the 0.1 the payer spent.
 */

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-status-cmd-test');

const h = vi.hoisted(() => {
  // One hour back, so "now" falls inside the first period window.
  const anchor = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    payer: '0x1111111111111111111111111111111111111111' as const,
    getTransactionReceipt: vi.fn(),
    readContract: vi.fn(),
    // Mutable, because `~/.jaw/config.json` is read with `JSON.parse` and a
    // cast: what it can carry is part of what this command has to survive.
    config: { x402: { topUpFloat: '5000000' } as Record<string, unknown> },
    session: {
      ownerAddress: '0x2222222222222222222222222222222222222222',
      sessionAddress: '0x1111111111111111111111111111111111111111',
      permissionId: '0xabc',
      chainId: 84532,
      expiry: Math.floor(Date.now() / 1000) + 6 * 86400,
      createdAt: anchor,
      mode: 'eip7702' as const,
      // The policy is derived from this on read, rather than from a summary
      // written beside it at grant time that could describe a different budget.
      permission: {
        account: '0x2222222222222222222222222222222222222222',
        spender: '0x1111111111111111111111111111111111111111',
        start: Math.floor(new Date(anchor).getTime() / 1000),
        end: Math.floor(Date.now() / 1000) + 6 * 86400,
        salt: '0xabc',
        // Registry USDC on Base Sepolia, so the asset lookup resolves.
        calls: [{ target: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', selector: '0xa9059cbb' }],
        spends: [
          {
            token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            allowance: '5000000', // 5 USDC per day
            unit: 'day',
            multiplier: 1,
          },
        ],
      },
    },
  };
});

vi.mock('../../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-status-cmd-test');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});

vi.mock('../../lib/keystore.js', () => ({ keystoreExists: () => true }));

vi.mock('../../lib/config.js', () => ({
  loadConfig: () => h.config,
  ensureDir: (dir: string) => {
    require('node:fs').mkdirSync(dir, { recursive: true });
  },
}));

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

// Both balances funded and readable: the only problem left for `diagnose` to
// find is the one this file exists to pin.
vi.mock('../../x402/balance.js', () => ({
  usdcBalance: async () => ({ formatted: '20' }),
  // The domain drift check reads the token's separator through this. Without it
  // the check would swallow a TypeError and report nothing, which is exactly the
  // shape of a wiring that looks connected and is not.
  //
  // Narrowed to that one read: `permission-onchain.ts` reads through the same
  // client, and a catch-all here answered its `getHash` with the separator
  // hash, which quietly moved the liveness these five other cases report from
  // `unknown` to `mismatch`.
  publicClientFor: () => ({
    getTransactionReceipt: h.getTransactionReceipt,
    readContract: (args: { functionName: string }) =>
      args.functionName === 'DOMAIN_SEPARATOR'
        ? h.readContract(args)
        : Promise.reject(new Error(`unexpected read in this suite: ${args.functionName}`)),
  }),
}));

const { appendX402Log, readX402Log, spendFigureOf } = await import('../../x402/ledger.js');
const { default: X402Status } = await import('./status.js');

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

const ONE_LIMIT = [
  { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', allowance: '5000000', unit: 'day', multiplier: 1 },
];

beforeEach(() => {
  // The fixture is shared and hoisted, so a test that widens the permission
  // must not leak into the next one.
  h.session.permission.spends = ONE_LIMIT.map((s) => ({ ...s }));
  h.config.x402 = { topUpFloat: '5000000' };
  // The base flags read these, and an inherited value would override the argv
  // the tests pass.
  delete process.env.JAW_OUTPUT;
  delete process.env.JAW_CHAIN_ID;
  delete process.env.JAW_API_KEY;
  h.getTransactionReceipt.mockReset();
  // Agreeing by default, so only the case that is about drift sees drift.
  h.readContract.mockReset();
  h.readContract.mockResolvedValue(
    hashDomain({
      domain: {
        name: 'USDC',
        version: '2',
        chainId: 84532n,
        verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      types: EIP712_DOMAIN_TYPE,
    })
  );
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  appendX402Log({
    at: new Date().toISOString(),
    url: 'https://api.example.com/tool',
    payer: h.payer,
    status: 'paid',
    amount: '100000', // 0.1 USDC paid out...
    topUpAmount: '5000000', // ...behind a 5 USDC pull through the permission
  });
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

describe('jaw x402 status', () => {
  it('reports the period figure from top-ups and the session figure from payments', async () => {
    const result = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    // The period figure counts top-ups, the session figure counts payments:
    // one 0.1 USDC payment behind a 5 USDC pull is 5 against the allowance.
    expect(result.policy.perPeriod[0].used).toBe('5000000');
    expect(result.policy.perPeriod[0].allowance).toBe('5000000');
    expect(result.spentThisSession).toBe('100000');
  });

  it('flags the drained grant and flips ready, even though payments barely started', async () => {
    const result = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(result.ready).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/granted allowance for this day is used up/);
  });

  it('prints the drained grant as used, apart from the session spend', async () => {
    const output = (await runStatus([])).join('\n');
    expect(output).toContain('at least 5 USDC of 5 USDC used this day');
    expect(output).toContain('at least 0.1 USDC of unlimited spent this session');
  });

  /**
   * The contract charges every limit whose token matches, so the cap on screen
   * is one of several and the tightest binds. The number that stands for it is
   * the smallest allowance, which answers "what refuses this payment" rather
   * than "what runs out first": 50 a day beside 100 a month picks the 50 and
   * overstates the month fifteenfold. Showing the others is cheaper than
   * choosing better on the reader's behalf.
   */
  it('names the other limits on the same token instead of reporting one as the answer', async () => {
    h.session.permission.spends = [
      { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', allowance: '5000000', unit: 'day', multiplier: 1 },
      { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', allowance: '100000000', unit: 'month', multiplier: 1 },
    ];

    const lines = (await runStatus([])).join('\n');
    expect(lines).toMatch(/of 5 USDC used this day/);
    expect(lines).toMatch(/of 100 USDC used this month/);
    expect(lines).toMatch(/all of them apply, so the tightest is what binds/);

    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.policy.perPeriod.map((l: { allowance: string }) => l.allowance)).toEqual(['5000000', '100000000']);
  });

  /**
   * A config-set limit wins over the grant's, and the config file is read with
   * `JSON.parse` and a cast, so it can carry an allowance nobody can read.
   * `checkPolicy` refuses every payment on that input, which makes it the limit
   * that binds; ranking it out of the reduction would report the next limit's
   * healthy figure and `ready: true` for a session that cannot pay at all.
   */
  it('flags a binding allowance it cannot read instead of reporting ready', async () => {
    h.config.x402 = {
      perPeriod: [{ allowance: 'not-a-number', unit: 'day', multiplier: 1, anchor: h.session.createdAt }],
    };

    const result = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(result.ready).toBe(false);
    expect(result.problems).toContainEqual(expect.stringMatching(/granted allowance for this day cannot be read/));
  });

  it('says nothing extra when the token has a single limit', async () => {
    const lines = (await runStatus([])).join('\n');
    expect(lines).not.toMatch(/all of them apply/);
    const report = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));
    expect(report.policy.perPeriod).toHaveLength(1);
  });

  /**
   * The command has to actually run the reconciliation, not merely be able to.
   * This file already exists because of a wiring regression, and ENGR-1258 was
   * filed over a capability that was accepted, forwarded, typed and dropped
   * with nothing reporting it. A row costing its ceiling forever is that shape.
   */
  it('reconciles an unchecked payment before reporting against it', async () => {
    const payTo = '0x3333333333333333333333333333333333333333';
    appendX402Log({
      at: new Date().toISOString(),
      url: 'https://api.example.com/tool',
      payer: h.payer,
      status: 'paid',
      amount: '1',
      authorized: '1000000',
      scheme: 'upto',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'eip155:84532',
      payTo,
      nonce: '0xfeed',
      txHash: `0x${'ab'.repeat(32)}`,
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      settlement: 'unverified',
    });
    h.getTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        {
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          topics: encodeEventTopics({
            abi: [TRANSFER_EVENT],
            eventName: 'Transfer',
            args: { from: h.payer, to: payTo as `0x${string}` },
          }),
          data: encodeAbiParameters([{ type: 'uint256' }], [400000n]),
        },
      ],
    });

    await runStatus(['--output', 'json']);

    const row = readX402Log().find((e) => e.nonce === '0xfeed');
    if (!row) throw new Error('the payment row went missing');
    expect(row.settlement).toBe('verified');
    expect(spendFigureOf(row)).toBe(400000n);
  });

  /**
   * The command has to run the check, not merely be able to. This file already
   * exists because of a wiring regression, and a check whose failure path is
   * "return null" is invisible when it is not called at all.
   */
  it('reports a registry whose EIP-712 domain no longer matches the token', async () => {
    h.readContract.mockResolvedValue(
      hashDomain({
        domain: {
          name: 'USD Coin',
          version: '2',
          chainId: 84532n,
          verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        },
        types: EIP712_DOMAIN_TYPE,
      })
    );

    const result = JSON.parse((await runStatus(['--output', 'json'])).join('\n'));

    expect(result.problems.some((p: string) => /EIP-712 domain/.test(p))).toBe(true);
    expect(result.ready).toBe(false);
  });
});
