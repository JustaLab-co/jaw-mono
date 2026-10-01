import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-keystore-test');

/**
 * When set, the next `writeFileSync` writes half its data and throws, the way a
 * full disk or a killed process leaves a file. `vi.spyOn` cannot reach an ESM
 * export, so the module is wrapped instead.
 */
const hooks = vi.hoisted(() => ({ tornWrite: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>) => {
    if (!hooks.tornWrite) return actual.writeFileSync(...args);
    hooks.tornWrite = false;
    const [file, data] = args;
    actual.writeFileSync(file, String(data).slice(0, String(data).length / 2));
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

vi.mock('./paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-keystore-test');
  return {
    PATHS: {
      root,
      config: p.join(root, 'config.json'),
      keystore: p.join(root, 'keystore.json'),
      sessionConfig: p.join(root, 'session-config.json'),
    },
  };
});

const { generateSessionKey, saveKeystore, loadSessionKey, deleteKeystore, keystoreExists, tryLoadKeystoreAddress } =
  await import('./keystore.js');
const { PATHS } = await import('./paths.js');

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('keystore', () => {
  it('generateSessionKey returns a 0x-prefixed 64-char hex string', () => {
    const key = generateSessionKey();
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('save then load round-trips the key', () => {
    const key = generateSessionKey();
    saveKeystore(key, '0xabc123');
    const loaded = loadSessionKey();
    expect(loaded).toBe(key);
  });

  it('loadSessionKey throws if keystore does not exist', () => {
    expect(() => loadSessionKey()).toThrow(/No session configured/);
  });

  it('deleteKeystore removes the file', () => {
    const key = generateSessionKey();
    saveKeystore(key, '0xabc123');
    expect(fs.existsSync(PATHS.keystore)).toBe(true);
    deleteKeystore();
    expect(fs.existsSync(PATHS.keystore)).toBe(false);
  });

  it('keystoreExists returns false when no file', () => {
    expect(keystoreExists()).toBe(false);
  });

  it('keystoreExists returns true after save', () => {
    saveKeystore(generateSessionKey(), '0xabc123');
    expect(keystoreExists()).toBe(true);
  });

  it('keystore.json has version 2 and expected fields', () => {
    saveKeystore(generateSessionKey(), '0xabc123');
    const raw = JSON.parse(fs.readFileSync(PATHS.keystore, 'utf-8'));
    expect(raw.version).toBe(2);
    expect(raw.privateKey).toBeDefined();
    expect(raw.address).toBe('0xabc123');
    expect(raw.createdAt).toBeDefined();
  });

  it('saveKeystore enforces 0o600 mode even when overwriting an existing file', () => {
    saveKeystore(generateSessionKey(), '0xabc123');
    expect(fs.statSync(PATHS.keystore).mode & 0o777).toBe(0o600);
    // Loosen the mode behind saveKeystore's back, then save again.
    fs.chmodSync(PATHS.keystore, 0o644);
    expect(fs.statSync(PATHS.keystore).mode & 0o777).toBe(0o644);
    saveKeystore(generateSessionKey(), '0xdef456');
    expect(fs.statSync(PATHS.keystore).mode & 0o777).toBe(0o600);
  });

  it('a write that fails partway leaves the previous key readable', () => {
    const key = generateSessionKey();
    saveKeystore(key, '0xabc123');

    hooks.tornWrite = true;
    expect(() => saveKeystore(generateSessionKey(), '0xdef456')).toThrow(/ENOSPC/);

    expect(loadSessionKey()).toBe(key);
  });

  it('tryLoadKeystoreAddress returns the stored address', () => {
    saveKeystore(generateSessionKey(), '0xSessionAddress');
    expect(tryLoadKeystoreAddress()).toBe('0xSessionAddress');
  });

  it('tryLoadKeystoreAddress returns null when there is no keystore', () => {
    deleteKeystore();
    expect(tryLoadKeystoreAddress()).toBeNull();
  });

  it('tryLoadKeystoreAddress returns null on a corrupt keystore', () => {
    fs.writeFileSync(PATHS.keystore, '{ not valid json', { mode: 0o600 });
    expect(tryLoadKeystoreAddress()).toBeNull();
  });
});
