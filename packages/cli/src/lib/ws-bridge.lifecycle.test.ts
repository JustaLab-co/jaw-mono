/**
 * The relay protocol between the CLI and the browser that holds the passkey,
 * against a relay on localhost and the real ECDH and AES-GCM from crypto.ts.
 *
 * The relay is a party in the middle that sees every frame. The CLI public key
 * reaches the browser only in the URL fragment, so the relay never learns it,
 * and that is what the cases below lean on: whatever the relay replays, forges
 * or injects, a request resolves only with an answer sealed under the secret
 * the CLI shares with the browser, for that request's own id, once.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { webcrypto } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';

import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  exportKeyToHex,
  generateKeyPair,
  importKeyFromHex,
  type EncryptedEnvelope,
} from './crypto.js';
import { WSBridge } from './ws-bridge.js';

type Inner = Record<string, unknown>;
type Answer = (socket: WebSocket, request: Inner, frame: string) => void | Promise<void>;

async function keyPairHex() {
  const pair = await generateKeyPair();
  return {
    pair,
    privateHex: await exportKeyToHex('private', pair.privateKey),
    publicHex: await exportKeyToHex('public', pair.publicKey),
  };
}

async function secretFor(privateKey: webcrypto.CryptoKey, peerPublicHex: string) {
  return deriveSharedSecret(privateKey, await importKeyFromHex('public', peerPublicHex));
}

async function seal(secret: webcrypto.CryptoKey, payload: Inner): Promise<string> {
  return JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) });
}

async function canOpen(secret: webcrypto.CryptoKey, frame: string): Promise<boolean> {
  try {
    await decryptMessage(secret, JSON.parse(frame) as EncryptedEnvelope);
    return true;
  } catch {
    return false;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A relay with the legitimate browser behind it. `answer` plays the browser for
 * each `rpc_request`; everything the CLI sends is kept, raw and decrypted.
 */
async function startRelay(answer: Answer) {
  const cli = await keyPairHex();
  const browser = await keyPairHex();
  const browserSecret = await secretFor(browser.pair.privateKey, cli.publicHex);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));

  const requests: Inner[] = [];
  const rawFrames: string[] = [];
  let connections = 0;
  let latest: WebSocket | undefined;

  server.on('connection', (socket) => {
    connections++;
    latest = socket;
    socket.on('message', async (data) => {
      const frame = data.toString();
      rawFrames.push(frame);
      const inner = await decryptMessage(browserSecret, JSON.parse(frame) as EncryptedEnvelope).catch(() => null);
      if (inner?.type === 'init') socket.send(await seal(browserSecret, { type: 'ready' }));
      if (inner?.type === 'rpc_request') {
        requests.push(inner);
        await answer(socket, inner, frame);
      }
    });
    socket.send(JSON.stringify({ type: 'status', browserConnected: true }));
  });

  const { port } = server.address() as { port: number };
  return {
    cli,
    browser,
    browserSecret,
    requests,
    rawFrames,
    connections: () => connections,
    push: (frame: string) => latest?.send(frame),
    bridge: (timeout = 2_000) =>
      new WSBridge({
        relayUrl: `ws://127.0.0.1:${port}`,
        session: 'test-session',
        timeout,
        connectTimeout: 2_000,
        config: { apiKey: 'test', chainId: 84532 },
        privateKeyHex: cli.privateHex,
        publicKeyHex: cli.publicHex,
        peerPublicKeyHex: browser.publicHex,
      }),
    close: () => {
      for (const client of server.clients) client.terminate();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function connected(answer: Answer, timeout?: number) {
  const relay = await startRelay(answer);
  const bridge = relay.bridge(timeout);
  cleanup.push(() => bridge.close(), relay.close);
  await bridge.connect();
  return { relay, bridge };
}

describe('one request, one ceremony', () => {
  it('puts exactly one request on the wire and resolves with its answer', async () => {
    const { relay, bridge } = await connected(async (socket, request) => {
      socket.send(
        await seal(relay.browserSecret, { type: 'rpc_response', id: request.id, success: true, data: '0xa1' })
      );
    });

    await expect(bridge.request('personal_sign', ['0xdead'])).resolves.toBe('0xa1');
    await pause(100);
    expect(relay.requests).toHaveLength(1);
    expect(relay.requests[0]).toMatchObject({ method: 'personal_sign', params: ['0xdead'] });
  });

  it('takes the first answer to a request and ignores a second one', async () => {
    const { relay, bridge } = await connected(async (socket, request) => {
      socket.send(
        await seal(relay.browserSecret, { type: 'rpc_response', id: request.id, success: true, data: '0x01' })
      );
      socket.send(
        await seal(relay.browserSecret, { type: 'rpc_response', id: request.id, success: true, data: '0x02' })
      );
    });

    await expect(bridge.request('personal_sign', ['0x1'])).resolves.toBe('0x01');
  });
});

describe('what the relay can replay', () => {
  it('an answer to an earlier request does not answer a later one', async () => {
    let earlierAnswer: string | undefined;
    const { relay, bridge } = await connected(async (socket, request) => {
      if (earlierAnswer) {
        socket.send(earlierAnswer);
        return;
      }
      earlierAnswer = await seal(relay.browserSecret, {
        type: 'rpc_response',
        id: request.id,
        success: true,
        data: '0xfirst',
      });
      socket.send(earlierAnswer);
    }, 400);

    await expect(bridge.request('wallet_sendCalls', [{ calls: [] }])).resolves.toBe('0xfirst');
    await expect(bridge.request('wallet_sendCalls', [{ calls: [] }])).rejects.toThrow(/timed out/);
    expect(relay.requests[0].id).not.toBe(relay.requests[1].id);
  });

  it('a request frame replayed back to the CLI is not taken as an answer', async () => {
    const { bridge } = await connected((socket, _request, frame) => {
      socket.send(frame);
    }, 400);

    await expect(bridge.request('personal_sign', ['0x1'])).rejects.toThrow(/timed out/);
  });
});

describe('what the relay can forge', () => {
  it('ignores anything not sealed with the secret the CLI shares with the browser', async () => {
    const stranger = await keyPairHex();
    const { relay, bridge } = await connected(async (socket, request) => {
      const strangerSecret = await secretFor(stranger.pair.privateKey, relay.browser.publicHex);
      socket.send('not json');
      socket.send(JSON.stringify({ type: 'encrypted', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' }));
      socket.send(JSON.stringify({ type: 'rpc_response', id: request.id, success: true, data: '0xplain' }));
      socket.send(
        await seal(strangerSecret, { type: 'rpc_response', id: request.id, success: true, data: '0xforged' })
      );
    }, 400);

    await expect(bridge.request('personal_sign', ['0x1'])).rejects.toThrow(/timed out/);
  });

  it('a key exchange the relay injects mid-session gets it neither the requests nor an answer', async () => {
    // The CLI accepts the new key, so the swap costs the session its browser.
    // What it must not do is hand the relay anything: without the CLI public
    // key the relay cannot derive the secret the CLI now uses.
    const attacker = await keyPairHex();
    const { relay, bridge } = await connected(() => undefined, 400);
    relay.push(JSON.stringify({ type: 'browser_connected' }));
    relay.push(JSON.stringify({ type: 'key_exchange', publicKey: attacker.publicHex }));
    await pause(100);

    const framesBefore = relay.rawFrames.length;
    const pending = bridge.request('wallet_sendCalls', [{ calls: [] }]);
    await pause(100);
    const [requestFrame] = relay.rawFrames.slice(framesBefore);
    expect(requestFrame).toBeDefined();

    const relayCanDerive = [
      await secretFor(attacker.pair.privateKey, relay.browser.publicHex),
      await secretFor(attacker.pair.privateKey, attacker.publicHex),
    ];
    for (const secret of relayCanDerive) {
      expect(await canOpen(secret, requestFrame)).toBe(false);
      relay.push(await seal(secret, { type: 'rpc_response', id: 'any', success: true, data: '0xforged' }));
    }
    await expect(pending).rejects.toThrow(/timed out/);
  });
});

describe('malformed frames', () => {
  it('a key exchange carrying a key that does not import is dropped, and the session keeps working', async () => {
    const { relay, bridge } = await connected(async (socket, request) => {
      socket.send(
        await seal(relay.browserSecret, { type: 'rpc_response', id: request.id, success: true, data: '0xstill' })
      );
    });
    for (const publicKey of ['zz', 42, null]) {
      relay.push(JSON.stringify({ type: 'browser_connected' }));
      relay.push(JSON.stringify({ type: 'key_exchange', publicKey }));
    }
    await pause(100);

    await expect(bridge.request('personal_sign', ['0x1'])).resolves.toBe('0xstill');
  });
});

describe('timeouts and dropped connections', () => {
  it('a request that times out closes the bridge, and a late answer resolves nothing', async () => {
    const { relay, bridge } = await connected(async (socket, request) => {
      await pause(600);
      socket.send(
        await seal(relay.browserSecret, { type: 'rpc_response', id: request.id, success: true, data: '0xlate' })
      );
    }, 300);

    await expect(bridge.request('personal_sign', ['0x1'])).rejects.toThrow(/timed out/);
    await pause(500);
    await expect(bridge.request('personal_sign', ['0x1'])).rejects.toThrow(/Not connected/);
    expect(relay.requests).toHaveLength(1);
  });

  it('a relay drop mid-request reconnects without resending the request', async () => {
    const { relay, bridge } = await connected((socket) => {
      socket.terminate();
    }, 2_500);

    await expect(bridge.request('wallet_sendCalls', [{ calls: [] }])).rejects.toThrow(/timed out/);
    expect(relay.connections()).toBeGreaterThan(1);
    expect(relay.requests).toHaveLength(1);
  });
});
