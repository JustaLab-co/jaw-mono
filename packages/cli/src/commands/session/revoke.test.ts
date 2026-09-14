import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * `session setup` replaces a session rather than adding to it, and it does not
 * always revoke what it replaces: the interactive path takes no for an answer,
 * and `--yes` never revokes. The session key is reused by default, so the
 * spender ends up holding two live grants while the config names one, and its
 * real authority is the sum.
 *
 * Setup now records the id it stops tracking, and this is the command that has
 * to act on it. Before that record existed, the id was gone with the
 * overwritten config and nothing could reach the permission again.
 */

const h = vi.hoisted(() => ({
  session: {
    ownerAddress: '0x2222222222222222222222222222222222222222',
    sessionAddress: '0x1111111111111111111111111111111111111111',
    permissionId: '0xcurrent',
    chainId: 84532,
    expiry: Math.floor(Date.now() / 1000) + 6 * 86400,
    createdAt: new Date().toISOString(),
    mode: 'eip7702' as const,
    orphanedPermissions: [] as Array<{ id: string; chainId: number; expiry: number }>,
  },
  deleted: { keystore: false, config: false },
  saved: [] as Array<{ orphans: Array<{ id: string }>; ownPermissionRevoked: boolean }>,
  requests: [] as Array<{ chainId: number; method: string; params: unknown }>,
  bridges: 0,
  failOn: null as string | null,
  jsonLines: [] as string[],
}));

vi.mock('../../lib/config.js', () => ({ loadConfig: () => ({ apiKey: 'k' }) }));

vi.mock('../../lib/keystore.js', () => ({
  keystoreExists: () => true,
  deleteKeystore: () => {
    h.deleted.keystore = true;
  },
}));

vi.mock('../../lib/session-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/session-config.js')>()),
  loadSessionConfig: () => h.session,
  deleteSessionConfig: () => {
    h.deleted.config = true;
  },
  saveRevokeProgress: (
    _config: unknown,
    progress: { orphans: Array<{ id: string }>; ownPermissionRevoked: boolean }
  ) => {
    h.saved.push(progress);
  },
}));

vi.mock('../../lib/bridge-singleton.js', () => ({
  getBridge: async ({ chainId }: { chainId: number }) => {
    h.bridges += 1;
    return {
      request: async (method: string, params: unknown) => {
        const id = (params as Array<{ id: string }>)[0]?.id;
        if (h.failOn && id === h.failOn) throw new Error('user rejected');
        h.requests.push({ chainId, method, params });
        return {};
      },
      close: () => undefined,
    };
  },
}));

const { default: SessionRevoke } = await import('./revoke.js');

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

beforeEach(() => {
  delete process.env.JAW_OUTPUT;
  delete process.env.JAW_CHAIN_ID;
  process.env.JAW_API_KEY = 'k';
  h.session.expiry = Math.floor(Date.now() / 1000) + 6 * 86400;
  h.session.orphanedPermissions = [];
  h.deleted = { keystore: false, config: false };
  h.saved = [];
  h.requests = [];
  h.bridges = 0;
  h.failOn = null;
});

async function runRevoke(argv: string[] = []): Promise<string[]> {
  const cmd = new SessionRevoke(argv, oclifConfig);
  const lines: string[] = [];
  h.jsonLines = lines;
  Object.assign(cmd, {
    log: (message?: string) => {
      lines.push(String(message ?? ''));
    },
  });
  await cmd.run();
  return lines;
}

const revokedIds = () => h.requests.map((r) => (r.params as Array<{ id: string }>)[0].id);

describe('jaw session revoke', () => {
  it('revokes the permission the session names', async () => {
    await runRevoke();
    expect(revokedIds()).toEqual(['0xcurrent']);
    expect(h.deleted).toEqual({ keystore: true, config: true });
  });

  it('also revokes the permissions the key holds that the session does not name', async () => {
    h.session.orphanedPermissions = [{ id: '0xorphan', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    await runRevoke();
    expect(revokedIds()).toEqual(['0xorphan', '0xcurrent']);
  });

  /**
   * Setup takes `--chain`, so replacing a session can move it and leave the old
   * permission on the chain it was granted on. One bridge per chain, because a
   * revoke sent to the wrong one reaches a manager that never saw the hash.
   */
  it('opens one browser per chain when an orphan sits on another one', async () => {
    h.session.orphanedPermissions = [{ id: '0xorphan', chainId: 8453, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    await runRevoke();
    expect(h.bridges).toBe(2);
    expect(h.requests.map((r) => r.chainId)).toEqual([8453, 84532]);
  });

  // An expired permission authorises nothing, so opening a window to revoke it
  // is worse than saying nothing, which is the call this command already made
  // for an expired session.
  it('skips an expired orphan', async () => {
    h.session.orphanedPermissions = [{ id: '0xstale', chainId: 84532, expiry: Math.floor(Date.now() / 1000) - 10 }];
    await runRevoke();
    expect(revokedIds()).toEqual(['0xcurrent']);
  });

  it('still revokes a live orphan when the session itself has expired', async () => {
    h.session.expiry = Math.floor(Date.now() / 1000) - 10;
    h.session.orphanedPermissions = [{ id: '0xorphan', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    await runRevoke();
    expect(revokedIds()).toEqual(['0xorphan']);
    expect(h.deleted).toEqual({ keystore: true, config: true });
  });

  it('touches nothing on chain when everything has expired', async () => {
    h.session.expiry = Math.floor(Date.now() / 1000) - 10;
    await runRevoke();
    expect(h.bridges).toBe(0);
    expect(h.deleted).toEqual({ keystore: true, config: true });
  });

  /**
   * The local files are what makes the remaining permission reachable. Deleting
   * them after a partial revoke would strand it exactly the way an unrecorded
   * orphan was stranded before.
   */
  it('keeps the local files when a revoke did not go through', async () => {
    h.session.orphanedPermissions = [{ id: '0xorphan', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    h.failOn = '0xorphan';
    await expect(runRevoke()).rejects.toThrow(/could not be revoked/);
    expect(h.deleted).toEqual({ keystore: false, config: false });
  });

  /**
   * The case that matters most here. A permission revoked from keys.jaw.id or
   * another machine can never be revoked again: core reads it from the relay
   * first, and the relay no longer has it. Letting that abort the batch would
   * mean the command a user runs to end their agent's spending authority
   * returns without ending it, every time, for as long as the dead id is on
   * file.
   */
  it('still revokes the live permission when an orphan cannot be revoked at all', async () => {
    h.session.orphanedPermissions = [{ id: '0xgone', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    h.failOn = '0xgone';

    await expect(runRevoke()).rejects.toThrow(/could not be revoked/);

    expect(revokedIds()).toEqual(['0xcurrent']);
    // Recorded as revoked, so the retry works through what is left instead of
    // spending a browser round trip on an id that is already gone.
    expect(h.saved.at(-1)).toEqual({
      orphans: [{ id: '0xgone', chainId: 84532, expiry: expect.any(Number) }],
      ownPermissionRevoked: true,
    });
  });

  it('reports the failure without hiding what did get revoked', async () => {
    h.session.orphanedPermissions = [{ id: '0xgone', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    h.failOn = '0xgone';
    const lines = await runRevoke(['--output', 'json']).catch(() => h.jsonLines);
    const report = JSON.parse(lines.join('\n'));
    expect(report).toMatchObject({
      revoked: false,
      revokedIds: ['0xcurrent'],
      failed: [{ id: '0xgone' }],
    });
  });

  /**
   * Revoking is not idempotent: core reads the permission from the relay before
   * sending and deletes it from there afterwards, so a second attempt at an id
   * already revoked fails before it sends anything. Every state this command
   * can stop in therefore has to name only ids that are still live, or the
   * retry dies on a stale one before reaching what it was run for.
   */
  it('drops each orphan from the session as it goes, so a later failure stays retryable', async () => {
    h.session.orphanedPermissions = [
      { id: '0xorphanA', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 },
      { id: '0xorphanB', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 },
    ];
    h.failOn = '0xcurrent';

    await expect(runRevoke()).rejects.toThrow(/could not be revoked/);

    expect(revokedIds()).toEqual(['0xorphanA', '0xorphanB']);
    // Written after each one, and the last write names nothing still to do:
    // the only permission left is the one the config already names.
    expect(h.saved.map((progress) => progress.orphans.map((o) => o.id))).toEqual([['0xorphanB'], []]);
    expect(h.saved.every((progress) => !progress.ownPermissionRevoked)).toBe(true);
    expect(h.deleted).toEqual({ keystore: false, config: false });
  });

  /**
   * Written before the files are deleted, and deliberately: a process killed
   * between the revoke landing and the cleanup leaves a session that knows its
   * permission is gone, rather than one that will spend a browser round trip
   * failing on it.
   */
  it('records the session permission as spent before cleaning up', async () => {
    await runRevoke();
    expect(h.saved).toEqual([{ orphans: [], ownPermissionRevoked: true }]);
    expect(h.deleted).toEqual({ keystore: true, config: true });
  });

  /**
   * A permission revoked from another device can never be revoked from here
   * again, so without a way out that one id would keep the local session alive
   * and this command failing every time it is run. Taking the way out is what
   * loses the ids, which is why it is a flag and why they are printed.
   */
  it('deletes the local session under --force, and names what stays live', async () => {
    h.session.orphanedPermissions = [{ id: '0xgone', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    h.failOn = '0xgone';

    const lines = await runRevoke(['--force']);

    expect(revokedIds()).toEqual(['0xcurrent']);
    expect(h.deleted).toEqual({ keystore: true, config: true });
    expect(lines.join('\n')).toMatch(/could not revoke 0xgone/);
    expect(lines.join('\n')).toMatch(/stay live until they expire/);
  });

  it('reports under --force that the local session went anyway', async () => {
    h.session.orphanedPermissions = [{ id: '0xgone', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    h.failOn = '0xgone';
    const report = JSON.parse((await runRevoke(['--output', 'json', '--force'])).join('\n'));
    expect(report).toMatchObject({ revoked: false, localSessionDeleted: true, failed: [{ id: '0xgone' }] });
  });

  it('keeps the local session without --force, so the rest stays retryable', async () => {
    h.session.orphanedPermissions = [{ id: '0xgone', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];
    h.failOn = '0xgone';
    await expect(runRevoke()).rejects.toThrow(/could not be revoked/);
    expect(h.deleted).toEqual({ keystore: false, config: false });
  });

  /**
   * An earlier run got the session's own permission revoked and then failed on
   * something else. Revoking is not idempotent, so attempting it again spends a
   * browser round trip that can only fail, and the flag is what stops it. A
   * flag of its own rather than a rewritten `expiry`, which would make that
   * field mean two things and break the recovered-struct check that reads it.
   */
  it('skips a permission an earlier run already revoked', async () => {
    h.session.permissionRevoked = true;
    h.session.orphanedPermissions = [{ id: '0xorphan', chainId: 84532, expiry: Math.floor(Date.now() / 1000) + 86400 }];

    await runRevoke();

    expect(revokedIds()).toEqual(['0xorphan']);
    expect(h.deleted).toEqual({ keystore: true, config: true });
  });
});
