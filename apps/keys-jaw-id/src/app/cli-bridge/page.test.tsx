// @vitest-environment jsdom
import { act, StrictMode } from 'react';
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

const created = vi.hoisted(() => ({
  appNames: [] as string[],
  handlerOptions: [] as unknown[],
  session: 's1',
  request: (async () => null) as (args: { method: string; params: unknown[] }) => Promise<unknown>,
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(`session=${created.session}&relay=ws://relay.test`),
}));
vi.mock('@jaw.id/ui', () => ({
  ReactUIHandler: class {
    constructor(options?: unknown) {
      created.handlerOptions.push(options);
    }
  },
}));
vi.mock('@jaw.id/core', async (original) => ({
  ...(await original<object>()),
  JAW: {
    create: (config: { appName: string }) => {
      created.appNames.push(config.appName);
      return { provider: { request: (args: { method: string; params: unknown[] }) => created.request(args) } };
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
let cliKeys: CryptoKeyPair;

async function connect(count: number, cli: CryptoKeyPair) {
  await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(count));
  const ws = FakeSocket.all[count - 1];
  await act(async () => ws.onopen!());
  const pageKey = ws.sent[0].publicKey as string;
  secret = await deriveSharedSecret(cli.privateKey, await importKeyFromHexString('public', pageKey));
  return ws;
}

async function start() {
  const cli = (cliKeys = await generateKeyPair());
  window.location.hash = `pk=${await exportKeyToHexString('public', cli.publicKey)}`;
  await act(async () => root.render(<CLIBridgePage />));
  return connect(1, cli);
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
  created.handlerOptions = [];
  created.session = 's1';
  created.request = async () => null;
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
  it('a new session on the same page takes the name of its client', async () => {
    const first = await start();
    await init(first, { appName: 'Claude' });
    expect(host.querySelector('h1')!.textContent).toBe('Claude');

    created.session = 's2';
    await act(async () => root.render(<CLIBridgePage />));
    expect(host.querySelector('h1')!.textContent).toBe('JAW CLI');
    const second = await connect(2, cliKeys);
    await init(second, { appName: 'Cursor' });

    expect(host.querySelector('h1')!.textContent).toBe('Cursor');
    expect(created.appNames).toEqual(['Claude', 'Cursor']);
  });

  it('labels the requester on the transaction screen instead of the wallet host', async () => {
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    expect(created.handlerOptions).toEqual([{ originLabel: 'via JAW bridge' }]);
  });

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

async function deliver(ws: FakeSocket, payload: Record<string, unknown>) {
  const { iv, cipherText } = await encrypt(secret, JSON.stringify(payload));
  await act(async () => {
    await ws.onmessage!({ data: JSON.stringify({ type: 'encrypted', iv: b64(iv), ciphertext: b64(cipherText) }) });
  });
}

async function answers(ws: FakeSocket, id: string) {
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

describe('cli-bridge page answers a repeated request', () => {
  const sign = { type: 'rpc_request', id: 'r1', method: 'personal_sign', params: ['0x68656c6c6f', '0xabc'] };

  it('tells the client it may ask again', async () => {
    const ws = await start();

    const ready = await init(ws, { appName: 'Claude' });

    expect(ready).toMatchObject({ type: 'ready', replays: true });
  });

  it('given an answered request, the same id and request get the same answer and the wallet is asked once', async () => {
    const asked = vi.fn(async () => '0xsig');
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    await deliver(ws, sign);
    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(1));

    await deliver(ws, sign);

    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(2));
    const [first, again] = await answers(ws, 'r1');
    expect(again).toEqual(first);
    expect(again).toEqual({ type: 'rpc_response', id: 'r1', success: true, data: '0xsig' });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('given a declined request, the same id gets the same refusal without a new dialog', async () => {
    const asked = vi.fn(async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    await deliver(ws, sign);
    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(1));

    await deliver(ws, sign);

    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(2));
    const [, again] = await answers(ws, 'r1');
    expect(again).toEqual({
      type: 'rpc_response',
      id: 'r1',
      success: false,
      error: { code: 4001, message: 'User rejected the request.' },
    });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('given a request still in the wallet, the same id waits for that answer instead of a second dialog', async () => {
    let approve!: (sig: string) => void;
    const asked = vi.fn(() => new Promise<unknown>((resolve) => (approve = resolve)));
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    await deliver(ws, sign);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));

    await deliver(ws, sign);
    await act(async () => approve('0xsig'));

    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(2));
    const signed = { type: 'rpc_response', id: 'r1', success: true, data: '0xsig' };
    expect(await answers(ws, 'r1')).toEqual([signed, signed]);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('given an answered request, the same id with other params is refused and the wallet is not asked', async () => {
    const asked = vi.fn(async () => '0xsig');
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    await deliver(ws, sign);
    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(1));

    await deliver(ws, { ...sign, params: ['0x6576696c', '0xabc'] });

    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(2));
    const [, refused] = await answers(ws, 'r1');
    expect(refused).toMatchObject({ type: 'rpc_response', id: 'r1', success: false, error: { code: -32600 } });
    expect(refused.data).toBeUndefined();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('given an answered request, the same id with another method is refused', async () => {
    const asked = vi.fn(async () => '0xsig');
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    await deliver(ws, sign);
    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(1));

    await deliver(ws, { ...sign, method: 'eth_signTypedData_v4' });

    await vi.waitFor(async () => expect(await answers(ws, 'r1')).toHaveLength(2));
    const [, refused] = await answers(ws, 'r1');
    expect(refused).toMatchObject({ success: false, error: { code: -32600 } });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('a new session does not answer from the answers of the last one', async () => {
    const asked = vi.fn(async () => '0xsig');
    created.request = asked;
    const first = await start();
    await init(first, { appName: 'Claude' });
    await deliver(first, sign);
    await vi.waitFor(async () => expect(await answers(first, 'r1')).toHaveLength(1));

    created.session = 's2';
    await act(async () => root.render(<CLIBridgePage />));
    const second = await connect(2, cliKeys);
    await init(second, { appName: 'Claude' });
    await deliver(second, sign);

    await vi.waitFor(async () => expect(await answers(second, 'r1')).toHaveLength(1));
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('a request with no id never reaches the wallet', async () => {
    const asked = vi.fn(async () => '0xsig');
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    const sent = ws.sent.length;

    await deliver(ws, { type: 'rpc_request', method: 'personal_sign', params: ['0x68656c6c6f', '0xabc'] });
    await deliver(ws, { ...sign, id: 'r2' });

    await vi.waitFor(async () => expect(await answers(ws, 'r2')).toHaveLength(1));
    expect(ws.sent).toHaveLength(sent + 1);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('a request repeated with its params unwrapped is the same request', async () => {
    const asked = vi.fn(async () => '0x14a34');
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    await deliver(ws, { type: 'rpc_request', id: 'r3', method: 'eth_chainId' });
    await vi.waitFor(async () => expect(await answers(ws, 'r3')).toHaveLength(1));

    await deliver(ws, { type: 'rpc_request', id: 'r3', method: 'eth_chainId', params: [] });

    await vi.waitFor(async () => expect(await answers(ws, 'r3')).toHaveLength(2));
    const [, again] = await answers(ws, 'r3');
    expect(again).toEqual({ type: 'rpc_response', id: 'r3', success: true, data: '0x14a34' });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('a request repeated with its object params in another key order is the same request', async () => {
    const asked = vi.fn(async () => ({ id: '0xbatch' }));
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    const calls = { version: '2.0', chainId: '0x14a34', calls: [{ to: '0x1', value: '0x0', data: '0x' }] };
    await deliver(ws, { type: 'rpc_request', id: 'r4', method: 'wallet_sendCalls', params: [calls] });
    await vi.waitFor(async () => expect(await answers(ws, 'r4')).toHaveLength(1));

    const reordered = { calls: [{ data: '0x', value: '0x0', to: '0x1' }], chainId: '0x14a34', version: '2.0' };
    await deliver(ws, { type: 'rpc_request', id: 'r4', method: 'wallet_sendCalls', params: [reordered] });

    await vi.waitFor(async () => expect(await answers(ws, 'r4')).toHaveLength(2));
    const [, again] = await answers(ws, 'r4');
    expect(again).toEqual({ type: 'rpc_response', id: 'r4', success: true, data: { id: '0xbatch' } });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('the same calls in another order are another request', async () => {
    const asked = vi.fn(async () => ({ id: '0xbatch' }));
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    const [a, b] = [
      { to: '0x1', data: '0x' },
      { to: '0x2', data: '0x' },
    ];
    await deliver(ws, { type: 'rpc_request', id: 'r5', method: 'wallet_sendCalls', params: [{ calls: [a, b] }] });
    await vi.waitFor(async () => expect(await answers(ws, 'r5')).toHaveLength(1));

    await deliver(ws, { type: 'rpc_request', id: 'r5', method: 'wallet_sendCalls', params: [{ calls: [b, a] }] });

    await vi.waitFor(async () => expect(await answers(ws, 'r5')).toHaveLength(2));
    const [, refused] = await answers(ws, 'r5');
    expect(refused).toMatchObject({ success: false, error: { code: -32600 } });
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('keeps the last 500 answers of a session', async () => {
    const asked = vi.fn(async () => '0x14a34');
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    const read = (id: string) => ({ type: 'rpc_request', id, method: 'eth_chainId', params: [] });
    for (let i = 0; i <= 500; i++) await deliver(ws, read(`q${i}`));
    await vi.waitFor(async () => expect(await answers(ws, 'q500')).toHaveLength(1));

    await deliver(ws, read('q1'));
    await vi.waitFor(async () => expect(await answers(ws, 'q1')).toHaveLength(2));
    expect(asked).toHaveBeenCalledTimes(501);
    await deliver(ws, read('q0'));
    await vi.waitFor(async () => expect(await answers(ws, 'q0')).toHaveLength(2));
    expect(asked).toHaveBeenCalledTimes(502);
  });

  it('distinct ids each reach the wallet', async () => {
    const asked = vi.fn(async () => '0xsig');
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });

    await deliver(ws, sign);
    await deliver(ws, { ...sign, id: 'r2' });

    await vi.waitFor(async () => expect(await answers(ws, 'r2')).toHaveLength(1));
    expect(asked).toHaveBeenCalledTimes(2);
  });
});

describe('cli-bridge page with nobody on the other side', () => {
  afterEach(() => vi.useRealTimers());

  it('given no server answers the key exchange, the page says the link is no longer active', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await start();

    await act(async () => vi.advanceTimersByTime(20_000));

    expect(host.textContent).toContain('This link is no longer active. Ask the agent for a new one.');
    // Left open: a client told the page left would open another tab.
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('given the server sends init in time, the page stays connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await start();
    await init(ws, { appName: 'Claude' });

    await act(async () => vi.advanceTimersByTime(60_000));

    expect(host.textContent).toContain('This tab is the signing backend for Claude.');
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('given a link opened again without its key, the page says the link is no longer active', async () => {
    window.location.hash = '';

    await act(async () => root.render(<CLIBridgePage />));

    expect(host.textContent).toContain('This link is no longer active. Ask the agent for a new one.');
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('given the relay drops before the wait ends, the page blames the relay, not the link', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await start();
    await act(async () => ws.onclose!());

    await act(async () => vi.advanceTimersByTime(20_000));

    expect(host.textContent).toContain('disconnected');
    expect(host.textContent).not.toContain('no longer active');
  });

  it('given the relay connection fails before the wait ends, the page keeps the relay error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await start();
    await act(async () => ws.onerror!());

    await act(async () => vi.advanceTimersByTime(20_000));

    expect(host.textContent).toContain('Relay connection failed');
    expect(host.textContent).not.toContain('no longer active');
  });

  it('given a link opened under StrictMode, the page keeps its key and connects', async () => {
    const cli = (cliKeys = await generateKeyPair());
    window.location.hash = `pk=${await exportKeyToHexString('public', cli.publicKey)}`;

    await act(async () =>
      root.render(
        <StrictMode>
          <CLIBridgePage />
        </StrictMode>
      )
    );

    const ws = await connect(FakeSocket.all.length || 1, cli);
    const ready = await init(ws, { appName: 'Claude' });
    expect(ready.type).toBe('ready');
    expect(host.textContent).not.toContain('no longer active');
  });

  it('just before the wait ends the page still waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await start();

    await act(async () => vi.advanceTimersByTime(19_000));

    expect(host.textContent).not.toContain('no longer active');
    expect(ws.close).not.toHaveBeenCalled();
  });
});
