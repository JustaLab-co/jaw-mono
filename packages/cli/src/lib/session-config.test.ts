import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-session-config-test');

vi.mock('./paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-session-config-test');
  return {
    PATHS: {
      root,
      config: p.join(root, 'config.json'),
      keystore: p.join(root, 'keystore.json'),
      sessionConfig: p.join(root, 'session-config.json'),
    },
  };
});

const {
  saveSessionConfig,
  loadSessionConfig,
  tryLoadSessionConfig,
  deleteSessionConfig,
  parseGrantedPermission,
  liveOrphans,
  saveRevokeProgress,
} = await import('./session-config.js');
const { PATHS } = await import('./paths.js');

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

const SAMPLE_CONFIG = {
  ownerAddress: '0xOwner' as const,
  sessionAddress: '0xSession' as const,
  permissionId: '0xPerm' as const,
  chainId: 84532,
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
  mode: 'eip7702' as const,
};

describe('session-config', () => {
  it('save then load round-trips', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    const loaded = loadSessionConfig();
    expect(loaded.ownerAddress).toBe('0xOwner');
    expect(loaded.sessionAddress).toBe('0xSession');
    expect(loaded.permissionId).toBe('0xPerm');
    expect(loaded.chainId).toBe(84532);
    expect(loaded.createdAt).toBeDefined();
  });

  it('round-trips the derivation mode', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    expect(loadSessionConfig().mode).toBe('eip7702');
  });

  // The writer cannot produce one any more, so the fixture is a file. Loading
  // stays permissive so `session status` and `session revoke` still work on a
  // session an older CLI wrote; auto mode is where it is refused.
  it('reads a config from before the field existed without complaining', () => {
    const legacy: Record<string, unknown> = { ...SAMPLE_CONFIG, createdAt: new Date().toISOString() };
    delete legacy.mode;
    fs.mkdirSync(PATHS.root, { recursive: true });
    fs.writeFileSync(PATHS.sessionConfig, JSON.stringify(legacy));
    expect(loadSessionConfig().mode).toBeUndefined();
    expect(loadSessionConfig().permissionId).toBe('0xPerm');
  });

  it('loadSessionConfig throws if file does not exist', () => {
    expect(() => loadSessionConfig()).toThrow(/No session configured/);
  });

  it('deleteSessionConfig removes the file', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    expect(fs.existsSync(PATHS.sessionConfig)).toBe(true);
    deleteSessionConfig();
    expect(fs.existsSync(PATHS.sessionConfig)).toBe(false);
  });

  it('loadSessionConfig throws a helpful error on corrupted JSON', () => {
    fs.writeFileSync(PATHS.sessionConfig, '{ not valid json', { mode: 0o600 });
    expect(() => loadSessionConfig()).toThrow(/corrupted/);
  });

  it('tryLoadSessionConfig returns null instead of throwing when the file is missing', () => {
    expect(fs.existsSync(PATHS.sessionConfig)).toBe(false);
    expect(() => loadSessionConfig()).toThrow();
    expect(tryLoadSessionConfig()).toBeNull();
  });

  it('tryLoadSessionConfig returns null on a corrupt file', () => {
    fs.writeFileSync(PATHS.sessionConfig, '{ not valid json', { mode: 0o600 });
    expect(tryLoadSessionConfig()).toBeNull();
  });

  it('tryLoadSessionConfig returns the config when it is readable', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    expect(tryLoadSessionConfig()?.permissionId).toBe('0xPerm');
  });

  it('saveSessionConfig enforces 0o600 mode even when overwriting an existing file', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    expect(fs.statSync(PATHS.sessionConfig).mode & 0o777).toBe(0o600);
    fs.chmodSync(PATHS.sessionConfig, 0o644);
    expect(fs.statSync(PATHS.sessionConfig).mode & 0o777).toBe(0o644);
    saveSessionConfig({ ...SAMPLE_CONFIG, permissionId: '0xPerm2' });
    expect(fs.statSync(PATHS.sessionConfig).mode & 0o777).toBe(0o600);
  });
});

/**
 * A `wallet_grantPermissions` response, in the shape core builds it: addresses
 * checksummed, salt and allowance as hex, the selector already computed from
 * the signature the request carried.
 */
const GRANT_RESPONSE = {
  account: '0x1111111111111111111111111111111111111111',
  spender: '0x2222222222222222222222222222222222222222',
  start: 1_756_000_000,
  end: 1_756_604_800,
  salt: '0xabc123',
  calls: [{ target: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', selector: '0xa9059cbb' }],
  spends: [
    {
      token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      allowance: '0x4c4b40',
      unit: 'day',
      multiplier: 1,
    },
  ],
  permissionId: '0xdeadbeef',
  chainId: '0x14a34',
};

/**
 * The struct is what every on-chain read is built from, and a struct that is
 * wrong in any part hashes to a permission that does not exist, so a read made
 * from it answers confidently about nothing. That is why a field arriving in an
 * unexpected shape has to drop the whole thing rather than be repaired: the
 * session then falls back to the local file, which is what it did before.
 */
describe('parseGrantedPermission', () => {
  it('takes the struct out of a grant response', () => {
    const permission = parseGrantedPermission(GRANT_RESPONSE);
    expect(permission).toEqual({
      account: GRANT_RESPONSE.account,
      spender: GRANT_RESPONSE.spender,
      start: GRANT_RESPONSE.start,
      end: GRANT_RESPONSE.end,
      salt: GRANT_RESPONSE.salt,
      calls: GRANT_RESPONSE.calls,
      spends: GRANT_RESPONSE.spends,
    });
  });

  it('accepts a decimal allowance, which is the other form the SDK takes', () => {
    const decimal = { ...GRANT_RESPONSE, spends: [{ ...GRANT_RESPONSE.spends[0], allowance: '5000000' }] };
    expect(parseGrantedPermission(decimal)?.spends[0].allowance).toBe('5000000');
  });

  it('accepts a permission with no spends, which a calls-only grant produces', () => {
    expect(parseGrantedPermission({ ...GRANT_RESPONSE, spends: [] })?.spends).toEqual([]);
  });

  // The response a wallet running an older core returns.
  it('returns undefined for a response carrying only the id', () => {
    expect(parseGrantedPermission({ permissionId: '0xdeadbeef', account: GRANT_RESPONSE.account })).toBeUndefined();
  });

  it.each([
    ['a non-object', 42],
    ['null', null],
    ['a malformed account', { ...GRANT_RESPONSE, account: '0x1234' }],
    ['a missing salt', { ...GRANT_RESPONSE, salt: undefined }],
    ['a non-hex salt', { ...GRANT_RESPONSE, salt: 'abc123' }],
    ['a zero start', { ...GRANT_RESPONSE, start: 0 }],
    ['a fractional end', { ...GRANT_RESPONSE, end: 1.5 }],
    ['no calls at all', { ...GRANT_RESPONSE, calls: [] }],
    ['a call without a selector', { ...GRANT_RESPONSE, calls: [{ target: GRANT_RESPONSE.account }] }],
    ['a truncated selector', { ...GRANT_RESPONSE, calls: [{ target: GRANT_RESPONSE.account, selector: '0xa905' }] }],
    ['an unknown spend unit', { ...GRANT_RESPONSE, spends: [{ ...GRANT_RESPONSE.spends[0], unit: 'fortnight' }] }],
    [
      'a spend without a multiplier',
      { ...GRANT_RESPONSE, spends: [{ ...GRANT_RESPONSE.spends[0], multiplier: undefined }] },
    ],
    ['a multiplier past uint16', { ...GRANT_RESPONSE, spends: [{ ...GRANT_RESPONSE.spends[0], multiplier: 70000 }] }],
    ['a non-numeric allowance', { ...GRANT_RESPONSE, spends: [{ ...GRANT_RESPONSE.spends[0], allowance: 'lots' }] }],
  ])('returns undefined for %s', (_label, raw) => {
    expect(parseGrantedPermission(raw)).toBeUndefined();
  });

  it('round-trips through the session config', () => {
    const permission = parseGrantedPermission(GRANT_RESPONSE);
    saveSessionConfig({ ...SAMPLE_CONFIG, permission });
    expect(loadSessionConfig().permission).toEqual(permission);
  });

  it('leaves the field absent on a session written without one', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    expect(loadSessionConfig().permission).toBeUndefined();
  });
});

/**
 * Permissions the key still holds that the session no longer names. They exist
 * because `session setup` replaces a session without always revoking what it
 * replaces, so the id has to be carried across rather than left behind in the
 * config that gets overwritten.
 */
describe('liveOrphans', () => {
  const now = 1_756_000_000;

  it('is empty for a session that never orphaned anything', () => {
    expect(liveOrphans(undefined, now)).toEqual([]);
  });

  it('keeps the ones that can still be used', () => {
    const live = { id: '0xlive', chainId: 84532, expiry: now + 86400 };
    expect(liveOrphans([live], now)).toEqual([live]);
  });

  // An expired permission authorises nothing, so carrying it would grow the
  // file for the life of the machine and offer a revoke worth nothing.
  it('drops the ones that have expired', () => {
    const stale = { id: '0xstale', chainId: 84532, expiry: now - 1 };
    const live = { id: '0xlive', chainId: 84532, expiry: now + 1 };
    expect(liveOrphans([stale, live], now)).toEqual([live]);
  });

  it('round-trips through the session config', () => {
    const orphans = [{ id: '0xorphan', chainId: 8453, expiry: now + 86400 }];
    saveSessionConfig({ ...SAMPLE_CONFIG, orphanedPermissions: orphans });
    expect(loadSessionConfig().orphanedPermissions).toEqual(orphans);
  });
});

/**
 * `session revoke` rewrites the session after each permission it revokes, so
 * that a failure part way through leaves a file naming only ids that are still
 * live. Revoking is not idempotent, so a stale id in there breaks the retry.
 */
describe('saveRevokeProgress', () => {
  const orphan = { id: '0xorphan', chainId: 8453, expiry: Math.floor(Date.now() / 1000) + 86400 };

  it('replaces the list without touching the rest of the session', () => {
    saveSessionConfig({ ...SAMPLE_CONFIG, orphanedPermissions: [orphan] });
    const before = loadSessionConfig();

    saveRevokeProgress(before, { orphans: [], ownPermissionRevoked: false });

    const after = loadSessionConfig();
    expect(after.orphanedPermissions).toBeUndefined();
    expect(after).toEqual({ ...before, orphanedPermissions: undefined });
  });

  /**
   * `createdAt` is what the session total is counted from, so going through
   * `saveSessionConfig` would hand the session cap a clean slate as a side
   * effect of revoking one permission.
   */
  it('keeps createdAt, which the session cap is counted from', () => {
    saveSessionConfig({ ...SAMPLE_CONFIG, orphanedPermissions: [orphan] });
    const before = loadSessionConfig();

    saveRevokeProgress(before, { orphans: [], ownPermissionRevoked: false });

    expect(loadSessionConfig().createdAt).toBe(before.createdAt);
  });

  it('keeps the file at 0o600', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    fs.chmodSync(PATHS.sessionConfig, 0o644);
    saveRevokeProgress(loadSessionConfig(), { orphans: [orphan], ownPermissionRevoked: false });
    expect(fs.statSync(PATHS.sessionConfig).mode & 0o777).toBe(0o600);
  });

  /**
   * On its own field rather than by rewriting `expiry`, which is what this did
   * first. `expiry` means when the permission ends, and the recovered-struct
   * check compares it against the permission's own `end`: overwriting it meant
   * a partly revoked session could never recover its struct again, and went
   * back to reporting "cannot tell", which is the state recovery exists to end.
   */
  it('marks the session permission as revoked without touching its expiry', () => {
    saveSessionConfig({ ...SAMPLE_CONFIG, orphanedPermissions: [orphan] });
    const before = loadSessionConfig();

    saveRevokeProgress(before, { orphans: [orphan], ownPermissionRevoked: true });

    const after = loadSessionConfig();
    expect(after.permissionRevoked).toBe(true);
    expect(after.expiry).toBe(before.expiry);
    expect(after.orphanedPermissions).toEqual([orphan]);
  });
});

/**
 * Recovering the permission struct turned two read-only commands into writers,
 * and the MCP server runs alongside a terminal, so two processes writing at
 * once is ordinary. A torn file loses the permission id, which is the exact
 * stranding the orphan list exists to prevent.
 */
describe('writing the session config', () => {
  it('leaves no partial file behind for a reader', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    // A rename is atomic on one filesystem, so nothing can observe a half
    // written config; what is observable is that no temp file survives.
    const strays = fs.readdirSync(PATHS.root).filter((f) => f.includes('.tmp'));
    expect(strays).toEqual([]);
    expect(loadSessionConfig().permissionId).toBe('0xPerm');
  });

  it('still lands at 0o600 through the rename', () => {
    saveSessionConfig(SAMPLE_CONFIG);
    expect(fs.statSync(PATHS.sessionConfig).mode & 0o777).toBe(0o600);
  });
});
