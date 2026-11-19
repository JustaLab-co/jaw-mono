import { randomUUID } from 'node:crypto';
import { on, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { WebSocketServer, type WebSocket } from 'ws';

import { Network } from './fixtures';
import { HTTPS, KEYS_URL } from './urls';

/**
 * The /cli-bridge page in WebKit on an iPhone, against a stand-in for the relay
 * and the CLI behind it. iOS ignores window.close() on a tab another app
 * opened, so the tab outlives the request, and the page has to keep saying the
 * request ended when the phone later drops its socket or reloads it.
 */

test.skip(HTTPS, 'the stand-in relay serves plain ws, not wss');

let relay: WebSocketServer;

test.beforeEach(async ({ context }) => {
  await new Network().install(context);
  relay = new WebSocketServer({ port: 0 });
  await once(relay, 'listening');
});

test.afterEach(() => {
  relay.clients.forEach((ws) => ws.terminate());
  relay.close();
});

const card = (page: Page) => page.getByRole('heading', { level: 1 }).locator('..');

// The wire format the CLI speaks: ECDH P-256 keys as SPKI hex, and frames in
// AES-256-GCM with base64 fields.
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const encode = (data: ArrayBuffer | Uint8Array, as: 'hex' | 'base64') => Buffer.from(new Uint8Array(data)).toString(as);
const decode = (text: string, as: 'hex' | 'base64') => new Uint8Array(Buffer.from(text, as));

/** Opens the link the CLI prints and plays the CLI until the page is ready. */
async function openBridge(page: Page) {
  const cli = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const pk = encode(await crypto.subtle.exportKey('spki', cli.publicKey), 'hex');
  const relayUrl = `ws://localhost:${(relay.address() as AddressInfo).port}`;
  // Buffers frames from the moment the page connects, which can be before
  // goto returns.
  const connected = new Promise<[WebSocket, ReturnType<typeof on>]>((resolve) =>
    relay.once('connection', (ws) => resolve([ws, on(ws, 'message')]))
  );
  const pageSocket = page.waitForEvent('websocket', (socket) => socket.url().startsWith(relayUrl));
  await page.goto(`${KEYS_URL}/cli-bridge?session=${randomUUID()}&relay=${encodeURIComponent(relayUrl)}#pk=${pk}`);

  const [ws, frames] = await connected;
  const receive = async () => JSON.parse(String((await frames.next()).value[0]));
  const { publicKey } = await receive();
  const pageKey = await crypto.subtle.importKey('spki', decode(publicKey, 'hex'), ECDH, false, []);
  const secret = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: pageKey },
    cli.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const send = async (frame: object) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(frame));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secret, plain);
    ws.send(JSON.stringify({ type: 'encrypted', iv: encode(iv, 'base64'), ciphertext: encode(ciphertext, 'base64') }));
  };

  await send({ type: 'init', chainId: 84532, apiKey: 'k', appName: 'Claude' });
  const { iv, ciphertext } = await receive();
  const ready = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv, 'base64') },
    secret,
    decode(ciphertext, 'base64')
  );
  expect(JSON.parse(new TextDecoder().decode(ready))).toMatchObject({ type: 'ready' });

  const socket = await pageSocket;
  return {
    shutdown: () => send({ type: 'shutdown' }),
    // No close frame, as when iOS drops the socket of a tab in the
    // background, so the page sees code 1006.
    drop: async () => {
      const closed = new Promise((resolve) => socket.once('close', resolve));
      ws.terminate();
      await closed;
    },
  };
}

test('a request that ended stays done when the phone drops the socket', async ({ page }) => {
  const bridge = await openBridge(page);
  await bridge.shutdown();
  await expect(card(page)).toContainText('This request has ended');

  await bridge.drop();
  // Working means nothing changes on screen, so give an error time to show.
  await page.waitForTimeout(500);
  await expect(card(page)).toContainText('Done ✓');
  await expect(card(page)).toContainText('Tap ◀ at the top left to go back to the app you came from.');
  await expect(card(page)).not.toContainText('Relay connection failed');
  await expect(card(page)).not.toContainText('Error');
});

test('a request that ended stays done when Safari reloads the tab', async ({ page }) => {
  const bridge = await openBridge(page);
  await bridge.shutdown();
  await expect(card(page)).toContainText('This request has ended');
  expect(new URL(page.url()).hash).toBe('');

  await page.reload();
  await expect(card(page)).toContainText('Done ✓');
  await expect(card(page)).not.toContainText('lost its link');
});

test('a socket dropped before the request ended reads as a lost connection', async ({ page }) => {
  const bridge = await openBridge(page);
  await bridge.drop();
  await expect(card(page)).toContainText('This tab lost its connection');
  await expect(card(page)).not.toContainText('Relay connection failed');
});
