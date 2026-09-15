import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// publicClientFor's transport depends on the configured apiKey, and its client
// cache must key on that apiKey so the long-lived `jaw mcp` server picks up a key
// set AFTER a first (keyless) read instead of caching the public-RPC client for
// good. These tests pin that: transport selection by apiKey, and cache reuse vs
// invalidation. Each case re-imports the module so its per-process cache is fresh.

const loadConfigMock = vi.fn();
vi.mock('../lib/config.js', () => ({ loadConfig: () => loadConfigMock() }));

const createPublicClientMock = vi.fn((..._args: unknown[]) => ({}) as unknown);
const httpMock = vi.fn((url?: string, options?: unknown) => ({ __url: url, __options: options }));
vi.mock('viem', async (importActual) => {
  const actual = await importActual<typeof import('viem')>();
  return { ...actual, createPublicClient: createPublicClientMock, http: httpMock };
});

async function freshPublicClientFor() {
  vi.resetModules();
  createPublicClientMock.mockClear();
  httpMock.mockClear();
  return (await import('./balance.js')).publicClientFor;
}

const transportUrlOf = (call: number) =>
  (createPublicClientMock.mock.calls[call]?.[0] as unknown as { transport: { __url?: string } }).transport.__url;

// `publicClientFor` resolves the key the way every other path does, and that
// includes `JAW_API_KEY`. A developer with one exported would otherwise have
// these cases read their own key off the environment rather than the config
// this file controls.
let realEnvKey: string | undefined;

beforeEach(() => {
  loadConfigMock.mockReset();
  realEnvKey = process.env['JAW_API_KEY'];
  delete process.env['JAW_API_KEY'];
});

afterEach(() => {
  if (realEnvKey === undefined) delete process.env['JAW_API_KEY'];
  else process.env['JAW_API_KEY'] = realEnvKey;
});

describe('publicClientFor transport + cache', () => {
  it('uses the public RPC (no url) when no apiKey is configured', async () => {
    loadConfigMock.mockReturnValue({});
    const publicClientFor = await freshPublicClientFor();
    publicClientFor(8453);
    expect(createPublicClientMock).toHaveBeenCalledTimes(1);
    expect(transportUrlOf(0)).toBeUndefined();
  });

  it('routes through the JAW proxy with the apiKey when one is configured', async () => {
    loadConfigMock.mockReturnValue({ apiKey: 'pk_test_123' });
    const publicClientFor = await freshPublicClientFor();
    publicClientFor(8453);
    expect(transportUrlOf(0)).toBe('https://api.justaname.id/proxy/v1/rpc?chainId=8453&api-key=pk_test_123');
  });

  // The reason this resolves through `apiKeyFor` rather than reading `apiKey`:
  // an install where nobody pasted a key still has one, and without this every
  // chain read goes out over the public RPC.
  it('routes through the proxy on the key the browser handed us', async () => {
    loadConfigMock.mockReturnValue({ workspaceApiKey: 'workspace-key' });
    const publicClientFor = await freshPublicClientFor();
    publicClientFor(8453);
    expect(transportUrlOf(0)).toContain('api-key=workspace-key');
  });

  it('reuses the cached client for the same chain and apiKey', async () => {
    loadConfigMock.mockReturnValue({ apiKey: 'pk_test_123' });
    const publicClientFor = await freshPublicClientFor();
    publicClientFor(8453);
    publicClientFor(8453);
    expect(createPublicClientMock).toHaveBeenCalledTimes(1);
  });

  it('builds a new client when the apiKey changes (no stale public-RPC client)', async () => {
    const publicClientFor = await freshPublicClientFor();
    loadConfigMock.mockReturnValue({}); // keyless first read
    publicClientFor(8453);
    loadConfigMock.mockReturnValue({ apiKey: 'pk_live_456' }); // key set later
    publicClientFor(8453);
    expect(createPublicClientMock).toHaveBeenCalledTimes(2);
    expect(transportUrlOf(0)).toBeUndefined();
    expect(transportUrlOf(1)).toContain('api-key=pk_live_456');
  });

  // These reads run inside the payment lock, so leaving them on viem's defaults
  // (10s across four attempts) lets one slow node hold up every payment on the
  // machine. Asserted on the options passed to `http`, not on wall-clock
  // behaviour, so the test stays fast and does not depend on viem's backoff.
  it.each([
    ['keyless', {}],
    ['keyed', { apiKey: 'pk_test_123' }],
  ])('bounds the %s transport with an explicit timeout and retry count', async (_label, config) => {
    loadConfigMock.mockReturnValue(config);
    const publicClientFor = await freshPublicClientFor();
    publicClientFor(8453);
    expect(httpMock.mock.calls[0]?.[1]).toEqual({ timeout: 5_000, retryCount: 2 });
  });
});
