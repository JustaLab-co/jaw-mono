import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import { buildInitPayload, readBridgeFailure, readInjectedApiKey, WSBridge } from './ws-bridge.js';

// The init envelope is the only thing the CLI tells the browser about the
// paymaster, so it has to carry the context and not the url alone. Dropping a
// configured `paymasters[chainId].context`, a Pimlico `sponsorshipPolicyId` for
// instance, sends a userOp signed through the browser out unsponsored while the
// same config sponsors fine in session mode.
describe('buildInitPayload', () => {
  const BASE = { apiKey: 'key-123', chainId: 8453 };

  it('carries a configured context alongside the url it belongs to', () => {
    const payload = buildInitPayload({
      ...BASE,
      paymasterUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=x',
      paymasterContext: { sponsorshipPolicyId: 'sp_my_policy' },
    });

    expect(payload).toMatchObject({
      type: 'init',
      apiKey: 'key-123',
      chainId: 8453,
      paymasterUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=x',
      paymasterContext: { sponsorshipPolicyId: 'sp_my_policy' },
    });
  });

  it('omits the context when there is no url to pair it with', () => {
    // The browser resolves a paymaster of its own when none arrives. A context
    // sent alone would be applied to whichever one that turns out to be.
    const payload = buildInitPayload({ ...BASE, paymasterContext: { sponsorshipPolicyId: 'sp_my_policy' } });

    expect(payload).not.toHaveProperty('paymasterContext');
    expect(payload.paymasterUrl).toBeUndefined();
  });

  it('sends a url with no context unchanged', () => {
    const payload = buildInitPayload({ ...BASE, paymasterUrl: 'https://configured.example/rpc' });

    expect(payload.paymasterUrl).toBe('https://configured.example/rpc');
    expect(payload).not.toHaveProperty('paymasterContext');
  });
});

// The browser fills in a key when the CLI arrived without one, and says so on
// `ready`. Read here rather than in the socket handler so the two absences can
// be asserted without a relay.
describe('readInjectedApiKey', () => {
  it('takes the key the browser filled in', () => {
    expect(readInjectedApiKey({ type: 'ready', chainId: 8453, apiKey: 'workspace-key' })).toBe('workspace-key');
  });

  it('is null when the browser sent none, which is every other case', () => {
    // A current browser omits it when the CLI carried its own key.
    expect(readInjectedApiKey({ type: 'ready', chainId: 8453 })).toBeNull();
    // An older one cannot send it at all, and an empty one is not a key.
    expect(readInjectedApiKey({ type: 'ready', apiKey: '' })).toBeNull();
    expect(readInjectedApiKey({ type: 'ready', apiKey: 42 })).toBeNull();
  });
});

// A machine connecting for the first time has no key, and the browser fills one
// in. The field's absence is what asks for that, so an empty string must not be
// what crosses instead: the browser would then have to read two things as the
// same request.
describe('buildInitPayload without a key', () => {
  it('omits the field rather than sending it empty', () => {
    const payload = buildInitPayload({ chainId: 8453 });

    expect('apiKey' in payload).toBe(false);
  });

  it('sends it when there is one', () => {
    expect(buildInitPayload({ apiKey: 'mine', chainId: 8453 })).toMatchObject({ apiKey: 'mine' });
  });
});

/**
 * The browser answers `ready` or it says why it will not. Before it could say,
 * a deployment missing the CLI's key looked from the terminal like a slow SDK:
 * fifteen seconds of nothing and then a timeout naming neither the key nor the
 * deployment.
 */
describe('readBridgeFailure', () => {
  it('takes the reason the browser refused with', () => {
    const reason = 'No API key: the CLI sent none and this deployment has none configured for it.';

    expect(readBridgeFailure({ type: 'error', reason })).toBe(reason);
  });

  it('still refuses when the browser named no reason', () => {
    // The refusal is the load-bearing part; a blank one must not read as
    // success and fall through to the timeout.
    expect(readBridgeFailure({ type: 'error' })).toBe('no reason given');
    expect(readBridgeFailure({ type: 'error', reason: '' })).toBe('no reason given');
  });

  it.each([
    ['a ready', { type: 'ready', chainId: 8453 }],
    ['an rpc response', { type: 'rpc_response', id: '1' }],
  ])('is null for %s, which is not a refusal', (_label, inner) => {
    expect(readBridgeFailure(inner)).toBeNull();
  });

  it('strips control characters before the reason reaches a terminal', () => {
    const hostile = readBridgeFailure({ type: 'error', reason: 'refused\u001b[31m\nSUCCESS' });

    expect(hostile).not.toContain('\u001b');
    expect(hostile).not.toContain('\n');
  });
});

/**
 * What the relay sends is network input. A frame the bridge cannot use has to
 * reject the connect with a reason, not throw inside the socket handler where
 * nothing catches it, and not hang until the connect timer fires.
 */
describe('WSBridge against a relay sending bad frames', () => {
  let relay: WebSocketServer | null = null;

  afterEach(() => {
    relay?.close();
    relay = null;
  });

  /** A relay that reports the browser connected, then sends `frame`. */
  const connectTo = async (frame: string) => {
    const server = new WebSocketServer({ port: 0 });
    relay = server;
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'status', browserConnected: true }));
      socket.send(frame);
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const bridge = new WSBridge({
      relayUrl: `ws://127.0.0.1:${port}`,
      session: 'test',
      connectTimeout: 2_000,
      config: { chainId: 8453 },
      privateKeyHex: '00',
      publicKeyHex: '00',
      peerPublicKeyHex: null,
    });
    try {
      return await bridge.connect();
    } finally {
      bridge.close();
    }
  };

  it.each([
    ['not hex', 'zz'],
    ['missing', undefined],
  ])('rejects a key_exchange whose public key is %s', async (_, publicKey) => {
    await expect(connectTo(JSON.stringify({ type: 'key_exchange', publicKey }))).rejects.toThrow(
      /invalid key_exchange public key/
    );
  });

  it('rejects a key_exchange whose key does not import, without waiting out the timer', async () => {
    const err = await connectTo(JSON.stringify({ type: 'key_exchange', publicKey: 'abcd' })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/did not connect within/);
  });

  it('drops the connection on a frame over the size limit', async () => {
    await expect(connectTo('x'.repeat(6 * 1024 * 1024))).rejects.toThrow(/payload/i);
  });
});
