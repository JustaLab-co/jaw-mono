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
import { expect, vi } from 'vitest';
import CLIBridgePage from './page';
import { created } from './harness-state';

export { created };

export class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close = vi.fn();
}

export const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export let host: HTMLDivElement;
export let root: Root;
export let secret: CryptoKey;
export let cliKeys: CryptoKeyPair;

export async function connect(count: number, cli: CryptoKeyPair) {
  await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(count));
  const ws = FakeSocket.all[count - 1];
  await act(async () => ws.onopen!());
  const pageKey = ws.sent[0].publicKey as string;
  secret = await deriveSharedSecret(cli.privateKey, await importKeyFromHexString('public', pageKey));
  return ws;
}

export async function start() {
  const cli = (cliKeys = await generateKeyPair());
  window.location.hash = `pk=${await exportKeyToHexString('public', cli.publicKey)}`;
  await act(async () => root.render(<CLIBridgePage />));
  return connect(1, cli);
}

export async function init(ws: FakeSocket, payload: Record<string, unknown>) {
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

export async function deliver(ws: FakeSocket, payload: Record<string, unknown>) {
  const { iv, cipherText } = await encrypt(secret, JSON.stringify(payload));
  await act(async () => {
    await ws.onmessage!({ data: JSON.stringify({ type: 'encrypted', iv: b64(iv), ciphertext: b64(cipherText) }) });
  });
}

export async function answers(ws: FakeSocket, id: string) {
  const opened = await Promise.all(
    ws.sent
      .filter((m) => m.type === 'encrypted')
      .map(async (m) =>
        JSON.parse(
          await decrypt(secret, {
            iv: unb64(m.iv as string),
            cipherText: unb64(m.ciphertext as string).buffer as ArrayBuffer,
          })
        )
      )
  );
  return opened.filter((m) => m.type === 'rpc_response' && m.id === id);
}

// jsdom hands out ArrayBuffers of its own realm, which WebCrypto refuses; a Buffer is accepted.
const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((alg, key, data) =>
  realDecrypt(alg, key, data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data)
);

export function setUp() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeSocket.all = [];
  created.appNames = [];
  created.configs = [];
  created.handlerOptions = [];
  created.session = 's1';
  created.query = null;
  created.request = async () => null;
  vi.stubGlobal('WebSocket', FakeSocket);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
}

export function tearDown() {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
}

export function rememberCliKeys(keys: CryptoKeyPair) {
  cliKeys = keys;
  return keys;
}
