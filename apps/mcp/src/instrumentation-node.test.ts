import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db/migrate', () => ({ runMigrations: vi.fn(async () => {}) }));
vi.mock('./connections/adapter', () => ({ sweepWraps: vi.fn(async () => {}) }));
vi.mock('./reconciler/run', () => ({ reconcile: vi.fn(async () => {}), purge: vi.fn(async () => {}) }));

import { sweepWraps } from './connections/adapter';
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
    delete process.env.JAW_MCP_RECONCILE_EVERY;
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
});
