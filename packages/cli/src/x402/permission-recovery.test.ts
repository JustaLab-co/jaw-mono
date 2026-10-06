import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Sessions created before the CLI kept the permission struct hold only the id,
 * and no view on the permission manager takes an id. Without this they report
 * "cannot tell" forever and cannot be added to, and the only remedy offered was
 * to run setup again, which revokes and re-grants a permission the relay could
 * have handed back.
 */

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-recovery-test');

vi.mock('../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-recovery-test');
  return { PATHS: { root, sessionConfig: p.join(root, 'session-config.json') } };
});

const { recoverPermission: recover } = await import('./permission-recovery.js');
const { sessionFileStore } = await import('../lib/session-config.js');
const recoverPermission = (...[session, apiKey, deps]: Parameters<typeof recover>) =>
  recover(session, apiKey, { ...deps, store: sessionFileStore });
const { PATHS } = await import('../lib/paths.js');

/**
 * A session being recovered always has a file on disk, and the write merges
 * into what is there rather than into the caller's snapshot, so the tests have
 * to put it there.
 */
function onDisk(config: Record<string, unknown>) {
  fs.writeFileSync(PATHS.sessionConfig, JSON.stringify(config, null, 2) + '\n');
  return config;
}

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** What the relay stores, which is the struct plus the id and chain. */
const RELAYED = {
  permissionId: '0xabc',
  account: '0x1111111111111111111111111111111111111111',
  spender: '0x2222222222222222222222222222222222222222',
  start: 1_756_000_000,
  end: 1_756_604_800,
  salt: '0xdef',
  calls: [{ target: USDC, selector: '0xa9059cbb' }],
  spends: [{ token: USDC, allowance: '10000000', unit: 'day', multiplier: 1 }],
  chainId: '0x14a34',
};

const SESSION = {
  ownerAddress: RELAYED.account,
  sessionAddress: RELAYED.spender,
  permissionId: '0xabc',
  chainId: 84532,
  // The permission's own end. They are the same number in practice, and the
  // recovery refuses a struct whose window does not describe this session.
  expiry: RELAYED.end,
  createdAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
  mode: 'eip7702' as const,
};

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

describe('recoverPermission', () => {
  it('returns the struct a session already carries without asking the relay', async () => {
    const fetchPermission = vi.fn();
    const permission = { ...RELAYED };
    const recovered = await recoverPermission({ ...SESSION, permission } as never, 'key', { fetchPermission });
    expect(recovered).toBe(permission);
    expect(fetchPermission).not.toHaveBeenCalled();
  });

  it('recovers the struct from the relay and writes it back', async () => {
    onDisk(SESSION);
    const recovered = await recoverPermission(SESSION, 'key', { fetchPermission: async () => RELAYED });

    expect(recovered).toMatchObject({ salt: '0xdef', start: RELAYED.start });
    const written = JSON.parse(fs.readFileSync(PATHS.sessionConfig, 'utf-8'));
    expect(written.permission).toEqual(recovered);
    // The timestamp the session spend total is counted from survives.
    expect(written.createdAt).toBe(SESSION.createdAt);
  });

  it('only pays for the round trip once', async () => {
    onDisk(SESSION);
    const fetchPermission = vi.fn(async () => RELAYED);
    await recoverPermission(SESSION, 'key', { fetchPermission });
    const stored = JSON.parse(fs.readFileSync(PATHS.sessionConfig, 'utf-8'));
    await recoverPermission(stored, 'key', { fetchPermission });
    expect(fetchPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * Every failure leaves the session as it was, which is how it behaved before
   * this existed. A recovery that cannot happen must not turn a working command
   * into an error.
   */
  it.each([
    ['no api key is configured', undefined, async () => RELAYED],
    [
      'the relay does not answer',
      'key',
      async () => {
        throw new Error('404');
      },
    ],
    ['the relay returns something unusable', 'key', async () => ({ permissionId: '0xabc' })],
  ])('returns undefined and writes nothing when %s', async (_label, apiKey, fetchPermission) => {
    const recovered = await recoverPermission(SESSION, apiKey as string | undefined, { fetchPermission });
    expect(recovered).toBeUndefined();
    expect(fs.existsSync(PATHS.sessionConfig)).toBe(false);
  });

  it('gives up rather than holding a command open on a slow relay', async () => {
    const recovered = await recoverPermission(SESSION, 'key', {
      fetchPermission: () => new Promise(() => undefined),
      timeoutMs: 5,
    });
    expect(recovered).toBeUndefined();
  });

  /**
   * `session add` proceeds when liveness is `unknown`, and `unknown` is what a
   * chain outside the client's registry returns. There the union would be built
   * from a relay response with nothing local to corroborate it, so it has to
   * describe this session before it is written.
   */
  it.each([
    ['a different account', { account: '0x9999999999999999999999999999999999999999' }],
    ['a different spender', { spender: '0x8888888888888888888888888888888888888888' }],
    ['a different window', { end: RELAYED.end + 86400 }],
  ])('refuses a struct for %s', async (_label, override) => {
    const recovered = await recoverPermission(SESSION, 'key', {
      fetchPermission: async () => ({ ...RELAYED, ...override }),
    });
    expect(recovered).toBeUndefined();
    expect(fs.existsSync(PATHS.sessionConfig)).toBe(false);
  });

  /**
   * Recovery holds its snapshot across a relay round trip. A `session revoke`
   * running beside it writes progress between browser approvals, and renaming
   * the old copy back over that would restore the expiry and the orphan list it
   * had just cleared, sending the next revoke at ids that are already gone.
   */
  it('merges into the file as it is now, not the snapshot it was handed', async () => {
    onDisk({ ...SESSION, orphanedPermissions: [{ id: '0xorphan', chainId: 84532, expiry: 1 }] });

    const recovered = await recoverPermission(SESSION, 'key', {
      fetchPermission: async () => {
        // What another process wrote while this one was waiting on the relay.
        onDisk({ ...SESSION, orphanedPermissions: [] });
        return RELAYED;
      },
    });

    const written = JSON.parse(fs.readFileSync(PATHS.sessionConfig, 'utf-8'));
    expect(written.permission).toEqual(recovered);
    expect(written.orphanedPermissions).toEqual([]);
  });

  it('writes nothing when the session went away while it was waiting', async () => {
    onDisk(SESSION);
    const recovered = await recoverPermission(SESSION, 'key', {
      fetchPermission: async () => {
        fs.rmSync(PATHS.sessionConfig);
        return RELAYED;
      },
    });
    expect(recovered).toBeUndefined();
    expect(fs.existsSync(PATHS.sessionConfig)).toBe(false);
  });
});
