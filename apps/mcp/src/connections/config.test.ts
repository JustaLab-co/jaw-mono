import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from './testkit';

setTestEnv();

afterEach(() => {
  setTestEnv();
  delete process.env.JAW_MCP_FLOAT_TARGET;
  delete process.env.JAW_MCP_INSECURE_FETCH_HOSTS;
  delete process.env.JAW_MCP_SWAP_URL;
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

describe('JAW_MCP_INSECURE_FETCH_HOSTS', () => {
  it.each(['https://mcp.jaw.id', 'https://127.0.0.1.example.com', 'https://127.attacker.com'])(
    'refuses to start behind %s',
    async (url) => {
      process.env.JAW_MCP_PUBLIC_URL = url;
      process.env.JAW_MCP_INSECURE_FETCH_HOSTS = '127.0.0.1:4021';
      const { config } = await import('./config');
      expect(() => config()).toThrow(/JAW_MCP_INSECURE_FETCH_HOSTS/);
    }
  );

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://mcp.test'])(
    'is allowed behind %s',
    async (url) => {
      process.env.JAW_MCP_PUBLIC_URL = url;
      process.env.JAW_MCP_INSECURE_FETCH_HOSTS = '127.0.0.1:4021';
      const { config } = await import('./config');
      expect(config().insecureFetchHosts).toEqual(new Set(['127.0.0.1:4021']));
    }
  );

  it('leaves a public server alone when unset', async () => {
    process.env.JAW_MCP_PUBLIC_URL = 'https://mcp.jaw.id';
    const { config } = await import('./config');
    expect(config().insecureFetchHosts.size).toBe(0);
  });
});

describe('JAW_MCP_SWAP_URL', () => {
  it('given it unset, then the swap backend is the production proxy', async () => {
    const { config } = await import('./config');
    expect(config().swapUrl).toBe('https://api.justaname.id/proxy/v2');
  });

  it('given a URL with a trailing slash, then it is read without it', async () => {
    process.env.JAW_MCP_SWAP_URL = 'http://127.0.0.1:4021/proxy/v2/';
    const { config } = await import('./config');
    expect(config().swapUrl).toBe('http://127.0.0.1:4021/proxy/v2');
  });

  it('given a value that is not a URL, then it refuses to start naming the variable', async () => {
    process.env.JAW_MCP_SWAP_URL = 'api.justaname.id';
    const { config } = await import('./config');
    expect(() => config()).toThrow(/JAW_MCP_SWAP_URL/);
  });
});
