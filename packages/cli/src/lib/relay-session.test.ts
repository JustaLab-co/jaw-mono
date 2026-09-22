import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-relay-session-test');

vi.mock('./paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-relay-session-test');
  return { PATHS: { root, relay: p.join(root, 'relay.json') } };
});

const { loadRelaySession, saveRelaySession } = await import('./relay-session.js');
const { PATHS } = await import('./paths.js');

const session = {
  session: 'abc',
  relayUrl: 'wss://relay.jaw.id',
  privateKey: '0x01',
  publicKey: '0x02',
  peerPublicKey: null,
  startedAt: '2026-09-22T00:00:00.000Z',
};

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('relay session', () => {
  it('save then load round-trips the session', () => {
    saveRelaySession(session);
    expect(loadRelaySession()).toEqual(session);
  });

  it('loadRelaySession returns null on invalid JSON', () => {
    fs.writeFileSync(PATHS.relay, '{ not valid json');
    expect(loadRelaySession()).toBeNull();
  });

  it('saveRelaySession enforces 0o600 even when overwriting a looser file', () => {
    fs.writeFileSync(PATHS.relay, '{}', { mode: 0o644 });
    fs.chmodSync(PATHS.relay, 0o644);
    saveRelaySession(session);
    expect(fs.statSync(PATHS.relay).mode & 0o777).toBe(0o600);
  });
});
