import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { WSBridgeConfig } from './ws-bridge.js';

const constructed: Array<{ config: WSBridgeConfig }> = [];

/** What the browser filled in, set per test before `getBridge` runs. */
let injectedApiKey: string | null = null;

vi.mock('./ws-bridge.js', () => ({
  WSBridge: vi.fn().mockImplementation((options: { config: WSBridgeConfig }) => {
    constructed.push(options);
    return { connect: vi.fn().mockResolvedValue(undefined), injectedApiKey };
  }),
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  saveConfig: vi.fn(),
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
import { loadConfig, saveConfig } from './config.js';

// `getBridge` resolves `config.paymasters[chainId]` once, which is what keeps
// the url and the context together. Split across a caller-passed option and a
// fallback lookup here, the context has no field to travel in and is dropped at
// the first hop: the same divergence the SDK-side resolution closes, one layer
// up.
describe('getBridge — paymaster threading', () => {
  const paymasterOf = () => constructed[0].config;

  beforeEach(() => {
    constructed.length = 0;
    injectedApiKey = null;
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

// `jaw x402 pay` runs unattended and reads the key off the config file, so a key
// that lived only for the connecting process would leave the paying half of the
// product without one.
describe('getBridge — keeping the key the browser filled in', () => {
  beforeEach(() => {
    constructed.length = 0;
    injectedApiKey = null;
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue({});
  });

  it('stores one the config did not have', async () => {
    injectedApiKey = 'workspace-key';

    await getBridge({ apiKey: '', chainId: 8453 });

    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ apiKey: 'workspace-key' });
  });

  // The user chose theirs and it is what carries their own attribution. This is
  // the one that must not regress.
  it('never replaces a key already in the config', async () => {
    injectedApiKey = 'workspace-key';
    vi.mocked(loadConfig).mockReturnValue({ apiKey: 'mine', defaultChain: 8453 });

    await getBridge({ apiKey: 'mine', chainId: 8453 });

    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
  });

  it('writes nothing when the browser filled in nothing', async () => {
    await getBridge({ apiKey: 'mine', chainId: 8453 });

    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
  });
});
