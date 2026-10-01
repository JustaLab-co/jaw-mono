import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

/**
 * The command someone runs because something is already wrong with the session
 * file, so it has to report a field it cannot read rather than die on it.
 *
 * The case that crashed: `sessionUsable` takes any finite expiry past now,
 * while `expiryInstant` also refuses one past what a Date can hold. A value
 * above 8.64e12 satisfies the first and not the second, so the session reads as
 * active with no instant to print.
 */

const h = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  liveness: 'unknown' as string,
}));

vi.mock('../../lib/keystore.js', () => ({ keystoreExists: () => true }));
vi.mock('../../lib/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../../lib/api-key.js', () => ({ apiKeyFor: () => undefined }));
vi.mock('../../x402/permission-recovery.js', () => ({ recoverPermission: async () => null }));
vi.mock('../../x402/permission-onchain.js', () => ({ readLiveness: async () => h.liveness }));

// Not mocked, deliberately: the bug lives in how these two disagree, so a stub
// of either would answer the question the test is asking.
vi.mock('../../lib/session-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/session-config.js')>();
  return { ...actual, loadSessionConfig: () => h.session };
});

const { default: SessionStatus } = await import('./status.js');

let oclifConfig: Config;

beforeAll(async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  oclifConfig = await Config.load({ root: packageRoot });
});

const session = (expiry: number | null) => ({
  ownerAddress: '0x2222222222222222222222222222222222222222',
  sessionAddress: '0x1111111111111111111111111111111111111111',
  permissionId: '0xabc',
  chainId: 8453,
  expiry,
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'eip7702' as const,
});

// An hour of slack past the seven days, so the floor lands on 7 rather than on
// 6 for the fraction of a second between here and the command reading the clock.
const SECONDS = Math.floor(Date.now() / 1000) + 7 * 86400 + 3600;
// A session file is JSON a person can edit, and this is the "never expires"
// shape they reach for. `policyFromPermission` guards against the same value.
const UNREADABLE = 99999999999999;

beforeEach(() => {
  h.session = session(SECONDS);
  h.liveness = 'unknown';
  delete process.env.JAW_OUTPUT;
  delete process.env.JAW_API_KEY;
});

async function runStatus(argv: string[] = []): Promise<string[]> {
  const cmd = new SessionStatus(argv, oclifConfig);
  const lines: string[] = [];
  Object.assign(cmd, { log: (message?: string) => lines.push(String(message ?? '')) });
  await cmd.run();
  return lines;
}

describe('jaw session status', () => {
  it('counts the days left on a session whose expiry reads', async () => {
    const out = (await runStatus()).join('\n');

    expect(out).toContain('Session active.');
    expect(out).toContain('Valid (7 days remaining)');
  });

  it('reports an unreadable expiry instead of crashing on it', async () => {
    h.session = session(UNREADABLE);

    const out = (await runStatus()).join('\n');

    // Active, because the expiry is past now, and with nothing to print for it.
    expect(out).toContain('Session active.');
    expect(out).toContain('Expires:          unknown');
    expect(out).toContain('Valid, for how long the file does not say');
  });

  it('still says a revoked session is revoked when the expiry will not read', async () => {
    h.session = session(UNREADABLE);
    h.liveness = 'revoked';

    // The chain outranks the file: time left on paper is worth nothing once the
    // permission is gone, and that has to survive the unreadable field.
    expect((await runStatus()).join('\n')).toContain('Revoked on chain');
  });

  it('reports an expiry the file does not carry at all', async () => {
    h.session = session(null);

    const out = (await runStatus()).join('\n');

    // Null is the conservative direction: no licence to sign, so expired.
    expect(out).toContain('Session expired.');
    expect(out).toContain('does not say when it ends');
  });
});
