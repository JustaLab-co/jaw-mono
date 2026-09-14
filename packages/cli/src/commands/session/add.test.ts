import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * An agent working under a scoped session that discovers it needs to pay could
 * only re-run setup, which revokes the grant it is working under: it loses its
 * other capabilities in the middle of the task. The only way to have both was
 * hand-writing the union, which means knowing the scope you already have.
 */

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NFT = '0x4444444444444444444444444444444444444444';
const MINT = '0x1249c58b';

const h = vi.hoisted(() => ({
  config: { apiKey: 'k' } as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  saved: null as Record<string, unknown> | null,
  requests: [] as Array<{ method: string; params: unknown }>,
  failRevoke: false,
  stderr: [] as string[],
  ownerBlocked: null as string | null,
  liveness: 'active' as string,
  connected: '0x1111111111111111111111111111111111111111',
  progress: [] as unknown[],
  onSave: undefined as (() => void) | undefined,
  onRevoke: undefined as (() => void) | undefined,
  recovered: undefined as unknown,
}));

vi.mock('../../lib/config.js', () => ({ loadConfig: () => h.config }));
vi.mock('../../lib/keystore.js', () => ({ keystoreExists: () => true }));
vi.mock('../../lib/session-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/session-config.js')>()),
  loadSessionConfig: () => h.session,
  saveSessionConfig: (config: Record<string, unknown>) => {
    h.saved = config;
    h.onSave?.();
  },
  saveRevokeProgress: (_config: unknown, progress: unknown) => {
    h.progress.push(progress);
  },
}));
// The guards `setup --x402` runs, which `add --x402` skipped. Mocked rather
// than reached, since they read balances on chain.
vi.mock('../../x402/funded-owner.js', () => ({
  whyOwnerCannotFundSession: async () => h.ownerBlocked,
  whySpenderCannotPay: async () => null,
}));
vi.mock('../../x402/permission-onchain.js', () => ({ readLiveness: async () => h.liveness }));
// Kept off the network: without this the "no struct" case reaches the relay.
vi.mock('../../x402/permission-recovery.js', () => ({
  recoverPermission: async (session: { permission?: unknown }) => session.permission ?? h.recovered,
}));

vi.mock('../../lib/bridge-singleton.js', () => ({
  getBridge: async () => ({
    request: async (method: string, params: unknown) => {
      h.requests.push({ method, params });
      if (method === 'eth_requestAccounts') return [h.connected];
      if (method === 'wallet_revokePermissions') {
        h.onRevoke?.();
        if (h.failRevoke) throw new Error('user rejected');
      }
      if (method === 'wallet_grantPermissions') {
        return {
          account: '0x1111111111111111111111111111111111111111',
          spender: '0x2222222222222222222222222222222222222222',
          start: 1_756_000_000,
          end: 1_756_604_800,
          salt: '0xdef',
          calls: [
            { target: NFT, selector: MINT },
            { target: USDC, selector: '0xa9059cbb' },
          ],
          spends: [{ token: USDC, allowance: '0x989680', unit: 'day', multiplier: 1 }],
          permissionId: '0xnew',
          chainId: '0x14a34',
        };
      }
      return {};
    },
    close: () => undefined,
  }),
}));

const { default: SessionAdd } = await import('./add.js');

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
  h.saved = null;
  h.requests = [];
  h.failRevoke = false;
  h.stderr = [];
  h.ownerBlocked = null;
  h.liveness = 'active';
  h.connected = '0x1111111111111111111111111111111111111111';
  h.progress = [];
  h.onSave = undefined;
  h.onRevoke = undefined;
  h.recovered = undefined;
  h.session = {
    ownerAddress: '0x1111111111111111111111111111111111111111',
    sessionAddress: '0x2222222222222222222222222222222222222222',
    permissionId: '0xold',
    chainId: 84532,
    expiry: Math.floor(Date.now() / 1000) + 6 * 86400,
    createdAt: new Date().toISOString(),
    mode: 'eip7702',
    permission: {
      account: '0x1111111111111111111111111111111111111111',
      spender: '0x2222222222222222222222222222222222222222',
      start: 1_756_000_000,
      end: 1_756_604_800,
      salt: '0xabc',
      calls: [{ target: NFT, selector: MINT }],
      spends: [],
    },
  };
});

async function runAdd(argv: string[]): Promise<string[]> {
  const cmd = new SessionAdd(argv, oclifConfig);
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

const granted = () => h.requests.find((r) => r.method === 'wallet_grantPermissions');

describe('jaw session add', () => {
  it('grants the union and keeps the session key', async () => {
    await runAdd(['--x402', '--limit', '10/day']);

    const params = (granted()?.params as Array<Record<string, unknown>>)[0];
    expect(params.spender).toBe('0x2222222222222222222222222222222222222222');
    const permissions = params.permissions as { calls: unknown[]; spends: unknown[] };
    expect(permissions.calls).toHaveLength(2);
    expect(permissions.spends).toEqual([{ token: USDC, allowance: '10000000', unit: 'day', multiplier: 1 }]);
  });

  /**
   * Granted before the old one is revoked, so the agent is never left without a
   * permission: a failure in between leaves it holding what it had.
   */
  it('grants before it revokes, and revokes the old one', async () => {
    await runAdd(['--x402']);
    expect(h.requests.map((r) => r.method)).toEqual([
      'eth_requestAccounts',
      'wallet_grantPermissions',
      'wallet_revokePermissions',
    ]);
    expect((h.requests[2].params as Array<{ id: string }>)[0].id).toBe('0xold');
    expect(h.saved?.permissionId).toBe('0xnew');
    // Recorded as an orphan on the way in and taken back out once the revoke
    // lands, so nothing between the grant and the cleanup can lose it.
    expect(h.saved?.orphanedPermissions).toEqual([{ id: '0xold', chainId: 84532, expiry: h.session.expiry }]);
    expect(h.progress).toEqual([{ orphans: [], ownPermissionRevoked: false }]);
  });

  /**
   * The union is on chain by the time the revoke is attempted, and opening the
   * second bridge can throw. Writing the session first is what keeps a live
   * permission from being recorded nowhere: unreachable by `session revoke`,
   * unmetered by status, with the config still naming the old id.
   */
  it('records the new permission before it tries to revoke', async () => {
    const order: string[] = [];
    h.onSave = () => order.push('saved');
    h.onRevoke = () => order.push('revoked');
    await runAdd(['--x402']);
    expect(order).toEqual(['saved', 'revoked']);
  });

  /**
   * The new permission is live by then, so the session has to record it. The old
   * one stays live until it expires, and it is recorded so `session revoke` can
   * still reach it, which is the same machinery a declined revoke in setup uses.
   */
  it('records the old permission when revoking it failed', async () => {
    h.failRevoke = true;
    await runAdd(['--x402']);

    expect(h.saved?.permissionId).toBe('0xnew');
    expect(h.saved?.orphanedPermissions).toEqual([{ id: '0xold', chainId: 84532, expiry: h.session.expiry }]);
    // Left on the list, since it is still live.
    expect(h.progress).toEqual([]);
    expect(h.stderr.join(' ')).toMatch(/revoking the old one failed/);
  });

  it('does nothing when the session already allows all of it', async () => {
    const lines = await runAdd(['--permissions', JSON.stringify({ calls: [{ target: NFT, selector: MINT }] })]);
    expect(lines.join(' ')).toMatch(/already allows all of this/);
    expect(h.requests).toEqual([]);
  });

  /**
   * The union needs the scope already granted, and only the stored struct has
   * it. A session written before that field keeps working, it just cannot be
   * merged against.
   */
  it('refuses a session that does not carry its granted permission', async () => {
    delete h.session.permission;
    await expect(runAdd(['--x402'])).rejects.toThrow(/does not carry the permission it was granted/);
    expect(h.requests).toEqual([]);
  });

  it('refuses an expired session, which has nothing to add to', async () => {
    h.session.expiry = Math.floor(Date.now() / 1000) - 10;
    await expect(runAdd(['--x402'])).rejects.toThrow(/expired/);
  });

  // The ceiling bounds what the merge asks for, not just what setup does.
  it('refuses a merge that goes over the grant ceiling', async () => {
    h.config = { apiKey: 'k', grantCeiling: '5/day' };
    await expect(runAdd(['--x402', '--limit', '10/day'])).rejects.toThrow(/over the 5\/day ceiling/);
    expect(h.requests).toEqual([]);
  });

  it('refuses when nothing was asked for', async () => {
    await expect(runAdd([])).rejects.toThrow(/Nothing to add/);
  });

  /**
   * `createdAt` is what the session spend total is counted from. Restamping it
   * would hand the session cap a clean slate as a side effect of adding a
   * capability, so an agent near its total would get a full budget back.
   */
  it('keeps the timestamp the session cap is counted from', async () => {
    const before = h.session.createdAt;
    await runAdd(['--x402']);
    expect(h.saved?.createdAt).toBe(before);
  });

  /**
   * The connected account decides who the union belongs to. A different one
   * grants a permission owned by someone else, leaves the revoke of the old one
   * failing because that account does not own it, and moves where payments pull
   * from.
   */
  it('refuses when a different account is connected in the browser', async () => {
    h.connected = '0x9999999999999999999999999999999999999999';
    await expect(runAdd(['--x402'])).rejects.toThrow(/is connected in the browser/);
    expect(h.requests.map((r) => r.method)).toEqual(['eth_requestAccounts']);
  });

  // The same guard setup runs: the grant carries a transfer to the session, and
  // an owner that cannot cover it leaves a permission that cannot be used.
  it('refuses when the owner cannot fund the session', async () => {
    h.ownerBlocked = 'holds 0 USDC';
    await expect(runAdd(['--x402'])).rejects.toThrow(/holds 0 USDC/);
    expect(h.requests.map((r) => r.method)).not.toContain('wallet_grantPermissions');
  });

  /**
   * Merging against a struct the chain does not recognise, and then revoking the
   * permission that is live, is the capability loss this command exists to
   * prevent.
   */
  it.each([
    ['revoked', /revoked on chain/],
    ['mismatch', /does not match the one that was granted/],
  ])('refuses a session the chain reports as %s', async (liveness, message) => {
    h.liveness = liveness;
    await expect(runAdd(['--x402'])).rejects.toThrow(message);
    expect(h.requests).toEqual([]);
  });

  // Not knowing is what every session reports without a reachable node, so it
  // cannot be a refusal.
  it('goes ahead when the chain could not be asked', async () => {
    h.liveness = 'unknown';
    await runAdd(['--x402']);
    expect(h.saved?.permissionId).toBe('0xnew');
  });

  /**
   * The example printed in the command's own help. `parsePermissionsConfig`
   * rejects a defined-but-empty `spends`, so sending one for a calls-only
   * session taking a calls-only addition throws after the browser is open.
   */
  it('adds a call to a session that spends nothing', async () => {
    const lines = await runAdd(['--permissions', JSON.stringify({ calls: [{ target: NFT, selector: '0xdeadbeef' }] })]);
    expect(lines.join(' ')).not.toMatch(/non-empty/);
    const params = (granted()?.params as Array<Record<string, unknown>>)[0];
    expect((params.permissions as { spends?: unknown }).spends).toBeUndefined();
    expect(h.saved?.permissionId).toBe('0xnew');
  });
});
