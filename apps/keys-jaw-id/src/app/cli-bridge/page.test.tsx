// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  decrypt,
  deriveSharedSecret,
  encrypt,
  exportKeyToHexString,
  generateKeyPair,
  importKeyFromHexString,
} from '@jaw.id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({ appNames: [] as string[] }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('session=s1&relay=ws://relay.test') }));
vi.mock('@jaw.id/ui', () => ({ ReactUIHandler: class {} }));
vi.mock('@jaw.id/core', async (original) => ({
  ...(await original<object>()),
  JAW: {
    create: (config: { appName: string }) => {
      created.appNames.push(config.appName);
      return { provider: { request: async () => null } };
    },
  },
}));

import CLIBridgePage from './page';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close = vi.fn();
}

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let host: HTMLDivElement;
let root: Root;
let secret: CryptoKey;

async function start() {
  const cli = await generateKeyPair();
  window.location.hash = `pk=${await exportKeyToHexString('public', cli.publicKey)}`;
  await act(async () => root.render(<CLIBridgePage />));
  await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  const ws = FakeSocket.all[0];
  await act(async () => ws.onopen!());
  const pageKey = ws.sent[0].publicKey as string;
  secret = await deriveSharedSecret(cli.privateKey, await importKeyFromHexString('public', pageKey));
  return ws;
}

async function init(ws: FakeSocket, payload: Record<string, unknown>) {
  const { iv, cipherText } = await encrypt(
    secret,
    JSON.stringify({ type: 'init', chainId: 84532, apiKey: 'k', ...payload })
  );
  const before = ws.sent.length;
  await act(async () => {
    await ws.onmessage!({ data: JSON.stringify({ type: 'encrypted', iv: b64(iv), ciphertext: b64(cipherText) }) });
  });
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(before));
  const reply = ws.sent.at(-1)!;
  return JSON.parse(
    await decrypt(secret, {
      iv: unb64(reply.iv as string),
      cipherText: unb64(reply.ciphertext as string).buffer as ArrayBuffer,
    })
  );
}

// jsdom hands out ArrayBuffers of its own realm, which WebCrypto refuses; a Buffer is accepted.
const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((alg, key, data) =>
  realDecrypt(alg, key, data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data)
);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeSocket.all = [];
  created.appNames = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('cli-bridge page app name', () => {
  it('the page and the SDK carry the name the client gave, cleaned', async () => {
    const ws = await start();

    const ready = await init(ws, { appName: '  Claude ‮ (via JAW MCP) ' });

    expect(ready.type).toBe('ready');
    expect(host.querySelector('h1')!.textContent).toBe('Claude (via JAW MCP)');
    expect(host.textContent).toContain('signing backend for Claude (via JAW MCP)');
    expect(created.appNames).toEqual(['Claude (via JAW MCP)']);
  });

  it('a client that gives no name is called JAW CLI', async () => {
    const ws = await start();

    await init(ws, {});

    expect(host.querySelector('h1')!.textContent).toBe('JAW CLI');
    expect(created.appNames).toEqual(['JAW CLI']);
  });

  it('a second init cannot rename the page or the SDK', async () => {
    const ws = await start();
    await init(ws, { appName: 'Claude' });

    await init(ws, { appName: 'Mallory', chainId: 8453 });

    expect(host.querySelector('h1')!.textContent).toBe('Claude');
    expect(created.appNames).toEqual(['Claude', 'Claude']);
  });

  it('the missing-key error names the client by its cleaned name', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false }));
    const ws = await start();

    const failure = await init(ws, { appName: ' Claude​ ', apiKey: '' });

    expect(failure).toEqual({
      type: 'error',
      reason: 'No API key: Claude sent none and this deployment has none configured for it.',
    });
  });

  it('before any init the page is called JAW CLI', async () => {
    await start();

    expect(host.querySelector('h1')!.textContent).toBe('JAW CLI');
  });

  it('when the relay closes, the page says which client disconnected', async () => {
    const ws = await start();
    await init(ws, { appName: 'Claude' });

    await act(async () => ws.onclose!());

    expect(host.textContent).toContain('Claude disconnected. You can close this tab.');
  });
});
