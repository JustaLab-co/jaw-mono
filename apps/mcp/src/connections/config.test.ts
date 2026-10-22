import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv } from './testkit';

setTestEnv();

afterEach(() => {
  setTestEnv();
  delete process.env.JAW_MCP_FLOAT_TARGET;
  delete process.env.JAW_MCP_INSECURE_FETCH_HOSTS;
  delete process.env.JAW_MCP_SWAP_URL;
  delete process.env.JAW_MCP_SWAP_QUOTE_TTL_SEC;
  delete process.env.JAW_MCP_SWAP_PROVIDERS;
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
    process.env.JAW_MCP_SWAP_URL = 'https://backend.example/proxy/v2/';
    const { config } = await import('./config');
    expect(config().swapUrl).toBe('https://backend.example/proxy/v2');
  });

  it('given a value that is not a URL, then it refuses to start naming the variable', async () => {
    process.env.JAW_MCP_SWAP_URL = 'api.justaname.id';
    const { config } = await import('./config');
    expect(() => config()).toThrow(/JAW_MCP_SWAP_URL/);
  });

  it.each([
    ['plain http', 'http://backend.example/proxy/v2'],
    ['a loopback address', 'https://127.0.0.1:4021/proxy/v2'],
    ['a private address', 'https://10.0.0.5/proxy/v2'],
    ['a private IPv6 address', 'https://[fd00::1]/proxy/v2'],
    ['localhost', 'https://localhost:4021/proxy/v2'],
    ['a query', 'https://backend.example/proxy/v2?key=1'],
    ['an empty query', 'https://backend.example/proxy/v2?'],
    ['a hash', 'https://backend.example/proxy/v2#x'],
  ])('given %s, then it refuses to start naming the variable', async (_, url) => {
    process.env.JAW_MCP_SWAP_URL = url;
    const { config } = await import('./config');
    expect(() => config()).toThrow(/JAW_MCP_SWAP_URL/);
  });

  it('given http to a host listed in JAW_MCP_INSECURE_FETCH_HOSTS, then it is read as is', async () => {
    process.env.JAW_MCP_INSECURE_FETCH_HOSTS = '127.0.0.1:4021';
    process.env.JAW_MCP_SWAP_URL = 'http://127.0.0.1:4021/proxy/v2/';
    const { config } = await import('./config');
    expect(config().swapUrl).toBe('http://127.0.0.1:4021/proxy/v2');
  });

  it('given http to a listed host on another port, then it refuses to start', async () => {
    process.env.JAW_MCP_INSECURE_FETCH_HOSTS = '127.0.0.1:4021';
    process.env.JAW_MCP_SWAP_URL = 'http://127.0.0.1:4022/proxy/v2';
    const { config } = await import('./config');
    expect(() => config()).toThrow(/JAW_MCP_SWAP_URL/);
  });
});

describe('JAW_MCP_SWAP_QUOTE_TTL_SEC', () => {
  it('given it unset, then the quote TTL is the backend default of 300 s', async () => {
    const { config } = await import('./config');
    expect(config().swapQuoteTtlSec).toBe(300);
  });

  it('given 660, then it is read as 660 s', async () => {
    process.env.JAW_MCP_SWAP_QUOTE_TTL_SEC = '660';
    const { config } = await import('./config');
    expect(config().swapQuoteTtlSec).toBe(660);
  });

  it.each(['60', '0', '1.5', '-300', 'five'])(
    'given %j, then it refuses to start naming the variable',
    async (value) => {
      process.env.JAW_MCP_SWAP_QUOTE_TTL_SEC = value;
      const { config } = await import('./config');
      expect(() => config()).toThrow(/JAW_MCP_SWAP_QUOTE_TTL_SEC/);
    }
  );
});

describe('JAW_MCP_SWAP_PROVIDERS', () => {
  it('given it unset, then jaw_swap signs Aurora quotes only', async () => {
    const { config } = await import('./config');
    expect(config().swapProviders).toEqual(new Set(['aurora']));
  });

  it.each([
    ['aurora,across,relay', ['aurora', 'across', 'relay']],
    ['relay,across', ['across', 'relay']],
    ['across', ['across']],
    ['aurora, across', ['aurora', 'across']],
    ['Aurora,Across', ['aurora', 'across']],
  ])('given %j, then those providers are signed', async (value, providers) => {
    process.env.JAW_MCP_SWAP_PROVIDERS = value;
    const { config } = await import('./config');
    expect(config().swapProviders).toEqual(new Set(providers));
  });

  it.each(['uniswap', 'aurora,', 'aurora,,across', ' ', ','])(
    'given %j, then it refuses to start naming the variable',
    async (value) => {
      process.env.JAW_MCP_SWAP_PROVIDERS = value;
      const { config } = await import('./config');
      expect(() => config()).toThrow(/JAW_MCP_SWAP_PROVIDERS must be a comma list of aurora, across and relay/);
    }
  );
});
