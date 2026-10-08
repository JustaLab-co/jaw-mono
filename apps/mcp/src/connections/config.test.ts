import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from './testkit';

setTestEnv();

afterEach(() => {
  delete process.env.JAW_MCP_FLOAT_TARGET;
  vi.resetModules();
});

describe('JAW_MCP_FLOAT_TARGET', () => {
  it.each(['0.25', '2.5e5', '1e6', '-1', 'lots'])('refuses %j with a message naming the variable', async (value) => {
    process.env.JAW_MCP_FLOAT_TARGET = value;
    const { config } = await import('./config');
    expect(() => config()).toThrow(/JAW_MCP_FLOAT_TARGET must be whole base units/);
  });

  it('reads whole base units', async () => {
    process.env.JAW_MCP_FLOAT_TARGET = '300000';
    const { config } = await import('./config');
    expect(config().floatTarget).toBe(300_000n);
  });
});
