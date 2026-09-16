import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { JawConfig } from './types.js';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-config-test');

vi.mock('./paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-config-test');
  return {
    PATHS: {
      root,
      config: p.join(root, 'config.json'),
      session: p.join(root, 'session.json'),
    },
  };
});
const { loadConfig, saveConfig, setConfigValue, setX402PolicyValue, redactConfig } = await import('./config.js');
const { PATHS } = await import('./paths.js');

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true });
  }
});

describe('config', () => {
  it('loadConfig returns empty object when no config exists', () => {
    expect(loadConfig()).toEqual({});
  });

  it('saveConfig creates config file', () => {
    saveConfig({ apiKey: 'test-key', defaultChain: 8453 });
    const saved = loadConfig();
    expect(saved.apiKey).toBe('test-key');
    expect(saved.defaultChain).toBe(8453);
  });

  it('setConfigValue creates directory and merges with existing config', () => {
    setConfigValue('apiKey', 'first');
    setConfigValue('defaultChain', 1);
    const config = loadConfig();
    expect(config.apiKey).toBe('first');
    expect(config.defaultChain).toBe(1);
    expect(fs.existsSync(PATHS.root)).toBe(true);
  });

  it('setConfigValue updates a single value', () => {
    saveConfig({ apiKey: 'old-key' });
    setConfigValue('apiKey', 'new-key');
    expect(loadConfig().apiKey).toBe('new-key');
  });

  it('coerces numeric keys passed as strings (the MCP tool path)', () => {
    // The MCP jaw_config_set tool types value as a string; a numeric key must
    // land as a number, not a string that would break `expiry * 86400`.
    setConfigValue('defaultChain', '8453');
    setConfigValue('sessionExpiry', '14');
    const config = loadConfig();
    expect(config.defaultChain).toBe(8453);
    expect(config.sessionExpiry).toBe(14);
  });

  it('rejects non-integer / non-positive values for numeric keys', () => {
    expect(() => setConfigValue('sessionExpiry', 'abc')).toThrow(/positive integer/);
    expect(() => setConfigValue('defaultChain', '0x10')).toThrow(/positive integer/);
    expect(() => setConfigValue('defaultChain', '-1')).toThrow(/positive integer/);
    expect(() => setConfigValue('sessionExpiry', '1.5')).toThrow(/positive integer/);
  });
});

describe('saveConfig writes atomically', () => {
  /**
   * The bridge writes this file on connect now, and the MCP server runs beside
   * a terminal, so a reader landing mid-write is ordinary rather than exotic. A
   * truncating write reads back as "not valid JSON" and costs the api key, the
   * paymasters and the x402 caps.
   */

  const previous: JawConfig = { apiKey: 'old-key', defaultChain: 8453 };

  it('never truncates the file a reader is already holding', () => {
    saveConfig(previous);
    // A second hard link to the same inode stands in for the open handle a
    // reader has: a write in place would empty it, a rename leaves it whole.
    const held = path.join(TEST_ROOT, 'held.json');
    fs.linkSync(PATHS.config, held);

    saveConfig({ apiKey: 'new-key' });

    expect(JSON.parse(fs.readFileSync(held, 'utf-8'))).toEqual(previous);
    expect(loadConfig()).toEqual({ apiKey: 'new-key' });
  });

  it('leaves the config untouched when the write itself fails', () => {
    saveConfig(previous);
    // Nothing can be written at the scratch path, so the save dies before the
    // swap. The real file must not have been opened at all.
    fs.mkdirSync(`${PATHS.config}.${process.pid}.tmp`);

    expect(() => saveConfig({ apiKey: 'new-key' })).toThrow();
    expect(loadConfig()).toEqual(previous);
  });

  it('leaves no scratch file behind', () => {
    saveConfig(previous);

    expect(fs.readdirSync(TEST_ROOT).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the file readable by its owner only', () => {
    saveConfig(previous);

    // The rename carries the temp file's mode across, so pinning it on the
    // temp is what pins it here.
    expect(fs.statSync(PATHS.config).mode & 0o777).toBe(0o600);
  });
});

describe('redactConfig', () => {
  it('masks the apiKey', () => {
    const redacted = redactConfig({ apiKey: 'abcdefgh-rest-is-secret' });
    expect(redacted.apiKey).toBe('abcdefgh...');
  });

  it('masks query-string secrets in paymaster URLs', () => {
    const redacted = redactConfig({
      paymasters: { 84532: { url: 'https://api.pimlico.io/v2/84532/rpc?apikey=pim_secret123' } },
    }) as { paymasters: Record<number, { url: string }> };
    expect(redacted.paymasters[84532].url).not.toContain('pim_secret123');
    expect(redacted.paymasters[84532].url).toContain('https://api.pimlico.io/v2/84532/rpc');
  });

  it('leaves paymaster URLs without query strings intact', () => {
    const redacted = redactConfig({
      paymasters: { 1: { url: 'https://paymaster.example.com/rpc' } },
    }) as { paymasters: Record<number, { url: string }> };
    expect(redacted.paymasters[1].url).toBe('https://paymaster.example.com/rpc');
  });

  it('masks the free-form paymaster context (a provider could stash a token there)', () => {
    const redacted = redactConfig({
      paymasters: { 84532: { url: 'https://pm.example.com/rpc', context: { sponsorshipPolicyId: 'sp_secret' } } },
    }) as { paymasters: Record<number, { url: string; context?: unknown }> };
    expect(redacted.paymasters[84532].context).toBe('***');
    expect(JSON.stringify(redacted)).not.toContain('sp_secret');
  });

  it('leaves the context undefined when there is none', () => {
    const redacted = redactConfig({
      paymasters: { 1: { url: 'https://pm.example.com/rpc' } },
    }) as { paymasters: Record<number, { context?: unknown }> };
    expect(redacted.paymasters[1].context).toBeUndefined();
  });
});

describe('setX402PolicyValue', () => {
  it('sets a scalar cap and merges into the x402 block', () => {
    setX402PolicyValue('maxAmountPerPayment', '50000');
    setX402PolicyValue('maxTotalPerSession', '1000000');
    expect(loadConfig().x402).toEqual({ maxAmountPerPayment: '50000', maxTotalPerSession: '1000000' });
  });

  it('stores topUpFloat as a scalar string, not an array (BigInt-safe at read time)', () => {
    setX402PolicyValue('topUpFloat', '2000000');
    const stored = loadConfig().x402?.topUpFloat;
    expect(stored).toBe('2000000');
    // Regression guard: the funder does BigInt(topUpFloat); an array would throw.
    expect(() => BigInt(stored as string)).not.toThrow();
  });

  it('rejects a non-numeric scalar amount instead of storing a footgun', () => {
    expect(() => setX402PolicyValue('topUpFloat', 'abc')).toThrow(/non-negative integer/);
    expect(() => setX402PolicyValue('maxAmountPerPayment', '-5')).toThrow(/non-negative integer/);
    expect(loadConfig().x402?.topUpFloat).toBeUndefined();
  });

  it('comma-splits an allow-list field', () => {
    setX402PolicyValue('allowedNetworks', 'eip155:8453, eip155:84532');
    expect(loadConfig().x402?.allowedNetworks).toEqual(['eip155:8453', 'eip155:84532']);
  });

  it('does not disturb other config keys', () => {
    saveConfig({ apiKey: 'keep-me' });
    setX402PolicyValue('maxAmountPerPayment', '10');
    const config = loadConfig();
    expect(config.apiKey).toBe('keep-me');
    expect(config.x402?.maxAmountPerPayment).toBe('10');
  });
});

describe('migrateConfig', () => {
  it('migrates paymasterUrl to paymasters with defaultChain', () => {
    saveConfig({
      apiKey: 'test',
      defaultChain: 1,
      paymasterUrl: 'https://pm.example.com',
    } as JawConfig);
    const config = loadConfig();
    expect(config.paymasters).toEqual({
      1: { url: 'https://pm.example.com' },
    });
    expect(config.paymasterUrl).toBeUndefined();
  });

  it('migrates paymasterUrl to paymasters with fallback chain 1', () => {
    saveConfig({
      apiKey: 'test',
      paymasterUrl: 'https://pm.example.com',
    } as JawConfig);
    const config = loadConfig();
    expect(config.paymasters).toEqual({
      1: { url: 'https://pm.example.com' },
    });
  });

  it('does not migrate if paymasters already exists', () => {
    saveConfig({
      apiKey: 'test',
      paymasters: { 1: { url: 'https://existing.com' } },
      paymasterUrl: 'https://old.com',
    } as JawConfig);
    const config = loadConfig();
    expect(config.paymasters).toEqual({ 1: { url: 'https://existing.com' } });
  });
});
