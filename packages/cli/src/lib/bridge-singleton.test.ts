import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { WSBridgeConfig } from './ws-bridge.js';

const constructed: Array<{ config: WSBridgeConfig }> = [];

vi.mock('./ws-bridge.js', () => ({
  WSBridge: vi.fn().mockImplementation((options: { config: WSBridgeConfig }) => {
    constructed.push(options);
    return { connect: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

// An existing session with a peer key, so getBridge reuses it and never reaches
// the browser-opening path.
vi.mock('./relay-session.js', () => ({
  loadRelaySession: vi.fn(() => ({
    session: 'session-1',
    relayUrl: 'wss://relay.jaw.id',
    privateKey: 'priv',
    publicKey: 'pub',
    peerPublicKey: 'peer',
    startedAt: '2026-01-01T00:00:00.000Z',
  })),
  saveRelaySession: vi.fn(),
  deleteRelaySession: vi.fn(),
}));

import { getBridge } from './bridge-singleton.js';
import { loadConfig } from './config.js';

// `getBridge` resolves `config.paymasters[chainId]` once, which is what keeps
// the url and the context together. Split across a caller-passed option and a
// fallback lookup here, the context has no field to travel in and is dropped at
// the first hop: the same divergence the SDK-side resolution closes, one layer
// up.
describe('getBridge — paymaster threading', () => {
  const paymasterOf = () => constructed[0].config;

  beforeEach(() => {
    constructed.length = 0;
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue({});
  });

  it('carries a configured url and context together to the bridge', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      paymasters: { 8453: { url: 'https://api.pimlico.io/v2/8453/rpc?apikey=x', context: { mode: 'SPONSORED' } } },
    });

    await getBridge({ apiKey: 'key-123', chainId: 8453 });

    expect(paymasterOf().paymasterUrl).toBe('https://api.pimlico.io/v2/8453/rpc?apikey=x');
    expect(paymasterOf().paymasterContext).toEqual({ mode: 'SPONSORED' });
  });

  it('leaves both unset when no paymaster is configured for the chain', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      paymasters: { 8453: { url: 'https://mainnet-only.example/rpc', context: { mode: 'SPONSORED' } } },
    });

    await getBridge({ apiKey: 'key-123', chainId: 84532 });

    // Not the other chain's url, and not the other chain's context either.
    expect(paymasterOf().paymasterUrl).toBeUndefined();
    expect(paymasterOf().paymasterContext).toBeUndefined();
  });

  it('sends a url with no configured context unchanged', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      paymasters: { 8453: { url: 'https://configured.example/rpc' } },
    });

    await getBridge({ apiKey: 'key-123', chainId: 8453 });

    expect(paymasterOf().paymasterUrl).toBe('https://configured.example/rpc');
    expect(paymasterOf().paymasterContext).toBeUndefined();
  });
});
