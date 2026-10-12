import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db/migrate', () => ({ runMigrations: vi.fn(async () => {}) }));
vi.mock('./connections/adapter', () => ({ sweepWraps: vi.fn(async () => {}) }));
vi.mock('./reconciler/run', () => ({ reconcile: vi.fn(async () => {}), purge: vi.fn(async () => {}) }));

import { sweepWraps } from './connections/adapter';
import { runMigrations } from './db/migrate';
import { prepare, reconcileSeconds } from './instrumentation-node';
import { purge, reconcile } from './reconciler/run';

describe('reconcileSeconds', () => {
  it('reconciles every minute unless set, and not at all on 0', () => {
    expect(reconcileSeconds(undefined)).toBe(60);
    expect(reconcileSeconds('')).toBe(60);
    expect(reconcileSeconds('30')).toBe(30);
    expect(reconcileSeconds('0')).toBe(0);
  });

  it('keeps the default for a value that is not seconds', () => {
    expect(reconcileSeconds('1m')).toBe(60);
    expect(reconcileSeconds('-5')).toBe(60);
  });
});

describe('prepare', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    process.env.JAW_MCP_TRUSTED_PROXY_HOPS = '1';
    process.env.JAW_MCP_PUBLIC_URL = 'http://mcp.test';
    process.env.JAW_KEYS_URL = 'http://keys.test';
    process.env.JAW_MCP_SEALING_KEYS = Buffer.alloc(32, 1).toString('base64url');
    delete process.env.JAW_MCP_RECONCILE_EVERY;
    delete process.env.JAW_MCP_FLOAT_TARGET;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('schedules no interval and never reconciles when set to 0', async () => {
    process.env.JAW_MCP_RECONCILE_EVERY = '0';
    const spy = vi.spyOn(globalThis, 'setInterval');

    await prepare();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(spy).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reconciles every 60 seconds when unset', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');

    await prepare();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(60_000);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(reconcile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepWraps).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('uses the configured period', async () => {
    process.env.JAW_MCP_RECONCILE_EVERY = '5';
    const spy = vi.spyOn(globalThis, 'setInterval');

    await prepare();

    expect(spy.mock.calls[0][1]).toBe(5_000);
  });

  it('given a valid config, then it migrates and does not exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await prepare();

    expect(exit).not.toHaveBeenCalled();
    expect(runMigrations).toHaveBeenCalledWith('postgres://test');
  });

  it.each([
    ['JAW_MCP_PUBLIC_URL', undefined, 'JAW_MCP_PUBLIC_URL is not set'],
    ['JAW_MCP_SEALING_KEYS', undefined, 'JAW_MCP_SEALING_KEYS'],
    ['JAW_MCP_FLOAT_TARGET', '0.25', 'JAW_MCP_FLOAT_TARGET must be whole base units'],
  ])('given %s set to %s, then it logs why and exits before migrating', async (name, value, error) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited');
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    // A fresh module, so no config cached by an earlier test answers instead.
    vi.resetModules();
    const fresh = await import('./instrumentation-node');
    const migrate = (await import('./db/migrate')).runMigrations;

    await expect(fresh.prepare()).rejects.toThrow('exited');

    expect(exit).toHaveBeenCalledWith(1);
    expect(logged.mock.calls.flat().join('\n')).toContain(error);
    expect(migrate).not.toHaveBeenCalled();
  });
});
