import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { WSBridgeConfig } from './ws-bridge.js';

const constructed: Array<{ config: WSBridgeConfig; connectTimeout?: number }> = [];

/** What the browser filled in, set per test before `getBridge` runs. */
let injectedApiKey: string | null = null;

vi.mock('./ws-bridge.js', () => ({
  WSBridge: vi.fn().mockImplementation((options: { config: WSBridgeConfig }) => {
    constructed.push(options);
    return { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(), injectedApiKey };
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
describe('getBridge, keeping the key the browser filled in', () => {
  beforeEach(() => {
    constructed.length = 0;
    injectedApiKey = null;
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue({});
  });

  it('stores one the config did not have, in its own field', async () => {
    injectedApiKey = 'workspace-key';

    await getBridge({ apiKey: undefined, chainId: 8453 });

    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ workspaceApiKey: 'workspace-key' });
  });

  // The user chose theirs and it is what carries their own attribution. This is
  // the one that must not regress.
  it('never touches the key the user chose', async () => {
    injectedApiKey = 'workspace-key';
    vi.mocked(loadConfig).mockReturnValue({ apiKey: 'mine', defaultChain: 8453 });

    await getBridge({ apiKey: 'mine', chainId: 8453 });

    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({
      apiKey: 'mine',
      defaultChain: 8453,
      workspaceApiKey: 'workspace-key',
    });
  });

  // The deployment answers with the current key on every connect, and taking it
  // is the only way a rotation reaches an install that already has one.
  it('replaces a workspace key that changed', async () => {
    injectedApiKey = 'rotated';
    vi.mocked(loadConfig).mockReturnValue({ workspaceApiKey: 'old' });

    await getBridge({ apiKey: 'old', chainId: 8453 });

    expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ workspaceApiKey: 'rotated' });
  });

  it('writes nothing when the same workspace key comes back', async () => {
    injectedApiKey = 'same';
    vi.mocked(loadConfig).mockReturnValue({ workspaceApiKey: 'same' });

    await getBridge({ apiKey: 'same', chainId: 8453 });

    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
  });

  // The whole point: a key we were handed is not asserted back, or the
  // deployment echoes it and never consults its own again.
  it('does not send a workspace key back to the browser', async () => {
    vi.mocked(loadConfig).mockReturnValue({ workspaceApiKey: 'ours' });

    await getBridge({ apiKey: 'ours', chainId: 8453 });

    expect(constructed[0].config.apiKey).toBeUndefined();
  });

  it('does send the key the user chose', async () => {
    vi.mocked(loadConfig).mockReturnValue({ apiKey: 'mine' });

    await getBridge({ apiKey: 'mine', chainId: 8453 });

    expect(constructed[0].config.apiKey).toBe('mine');
  });

  it('writes nothing when the browser filled in nothing', async () => {
    await getBridge({ apiKey: 'mine', chainId: 8453 });

    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
  });
});

describe('refreshWorkspaceApiKey', () => {
  beforeEach(() => {
    constructed.length = 0;
    injectedApiKey = null;
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue({ workspaceApiKey: 'old-key' });
  });

  /**
   * The failure this guards: clearing first and then not reaching a browser,
   * which is the normal case for an agent, left the install with no key at all
   * and nothing short of `jaw session setup` to get one back.
   */
  it('leaves the stored key alone when no browser answers', async () => {
    const { loadRelaySession } = await import('./relay-session.js');
    vi.mocked(loadRelaySession).mockReturnValueOnce(null);
    const { refreshWorkspaceApiKey } = await import('./bridge-singleton.js');

    await expect(refreshWorkspaceApiKey()).rejects.toThrow(/may not open one/);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('never asks a browser to be opened', async () => {
    const { loadRelaySession } = await import('./relay-session.js');
    vi.mocked(loadRelaySession).mockReturnValueOnce(null);
    const { refreshWorkspaceApiKey } = await import('./bridge-singleton.js');

    await expect(refreshWorkspaceApiKey()).rejects.toThrow();
    // Nothing was constructed, so nothing could have opened a window.
    expect(constructed).toHaveLength(0);
  });

  /**
   * Behind a payment holding the lock, with nobody being waited on. The default
   * connect wait is sized for a person opening a window, and spending it here
   * buys half a minute of silence for a 403 that was never about the key.
   */
  it('gives the paired browser a short wait, not the human-sized one', async () => {
    injectedApiKey = 'new-key';
    vi.mocked(loadConfig)
      .mockReturnValueOnce({ workspaceApiKey: 'old-key' })
      .mockReturnValue({ workspaceApiKey: 'new-key' });
    const { refreshWorkspaceApiKey } = await import('./bridge-singleton.js');

    await refreshWorkspaceApiKey();

    expect(constructed[0].connectTimeout).toBeLessThanOrEqual(5_000);
  });

  it('answers with the key the browser handed over, and nothing when it is the same', async () => {
    injectedApiKey = 'new-key';
    vi.mocked(loadConfig)
      .mockReturnValueOnce({ workspaceApiKey: 'old-key' })
      .mockReturnValue({ workspaceApiKey: 'new-key' });
    const { refreshWorkspaceApiKey } = await import('./bridge-singleton.js');

    expect(await refreshWorkspaceApiKey()).toBe('new-key');
  });
});

describe('getBridge, reuseOnly', () => {
  beforeEach(() => {
    constructed.length = 0;
    injectedApiKey = null;
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue({});
  });

  /**
   * An unattended payment is the only caller, and it cannot replace a pairing it
   * drops. Deleting one here costs the person a browser window on their next
   * command, for a relay that may just have hiccupped.
   */
  it('keeps the pairing when the connect fails', async () => {
    const { WSBridge } = await import('./ws-bridge.js');
    vi.mocked(WSBridge).mockImplementationOnce(
      () => ({ connect: vi.fn().mockRejectedValue(new Error('relay down')), close: vi.fn() }) as never
    );
    const { deleteRelaySession } = await import('./relay-session.js');

    await expect(getBridge({ reuseOnly: true, chainId: 8453 })).rejects.toThrow(/relay down/);
    expect(deleteRelaySession).not.toHaveBeenCalled();
  });
});
