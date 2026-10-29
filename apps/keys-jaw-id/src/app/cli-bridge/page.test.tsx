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
  /** The whole query when a test opens the page at another URL than a session link. */
  query: null as string | null,
  request: (async () => null) as (args: { method: string; params: unknown[] }) => Promise<unknown>,
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(created.query ?? `session=${created.session}&relay=ws://relay.test`),
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

import { createHmac } from 'node:crypto';
import CLIBridgePage from './page';

class FakeSocket {
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
  created.query = null;
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

    await act(async () => ws.onclose!({ code: 1006 }));

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
    await act(async () => ws.onclose!({ code: 1006 }));

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
    expect(host.textContent).toContain('Connecting to relay...');

    await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    const ws = await connect(FakeSocket.all.length, cli);
    const ready = await init(ws, { appName: 'Claude' });
    expect(ready.type).toBe('ready');
    expect(host.textContent).not.toContain('no longer active');
  });

  it('given init arrives after the page gave up, the page is connected again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await start();
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(host.textContent).toContain('no longer active');

    await init(ws, { appName: 'Claude' });

    expect(host.textContent).toContain('This tab is the signing backend for Claude.');
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

describe('cli-bridge page when the link is opened in another tab', () => {
  // The relay keeps one browser per session and closes the old one with 4003.
  const REPLACED = 4003;

  function leaving() {
    const close = vi.fn();
    const replace = vi.fn();
    vi.stubGlobal('close', close);
    vi.stubGlobal('location', { replace });
    return { close, replace };
  }

  it('given another tab took the link, this tab closes and leaves for a page with no session', async () => {
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    const { close, replace } = leaving();

    await act(async () => ws.onclose!({ code: REPLACED }));

    expect(close).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/cli-bridge?replaced=1');
    const target = new URL(replace.mock.calls[0][0], 'https://keys.jaw.id');
    expect(target.searchParams.has('session')).toBe(false);
    expect(target.searchParams.has('relay')).toBe(false);
    expect(target.hash).toBe('');
  });

  it('given a request still in the wallet, another tab taking the link still makes this tab leave', async () => {
    // The owner never answers: the dialog stays open.
    const asked = vi.fn(() => new Promise<unknown>(() => undefined));
    created.request = asked;
    const ws = await start();
    await init(ws, { appName: 'Claude' });
    await deliver(ws, { type: 'rpc_request', id: 'r1', method: 'wallet_sendCalls', params: [{ calls: [] }] });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    const { close, replace } = leaving();

    await act(async () => ws.onclose!({ code: REPLACED }));

    expect(close).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/cli-bridge?replaced=1');
  });

  it.each([1000, 1006, 4004])(
    'given the relay closes with %i, the tab stays and says the client disconnected',
    async (code) => {
      const ws = await start();
      await init(ws, { appName: 'Claude' });
      const { close, replace } = leaving();

      await act(async () => ws.onclose!({ code }));

      expect(close).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(host.textContent).toContain('Claude disconnected. You can close this tab.');
    }
  );

  it('given an address with the replaced marker and a session, it still connects to nothing', async () => {
    created.query = 'replaced=1&session=s1&relay=ws://relay.test';
    window.location.hash = `pk=${await exportKeyToHexString('public', (await generateKeyPair()).publicKey)}`;

    await act(async () => root.render(<CLIBridgePage />));
    // The page derives its key before it opens a socket, so give that time to happen.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));

    expect(host.textContent).toContain('This link is open in another tab. You can close this one.');
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('given the page opened at the replaced marker, it says the link is open in another tab and connects to nothing', async () => {
    created.query = 'replaced=1';
    window.location.hash = '';

    await act(async () => root.render(<CLIBridgePage />));

    expect(host.textContent).toContain('This link is open in another tab. You can close this one.');
    expect(host.textContent).not.toContain('Missing required parameters');
    expect(host.textContent).not.toContain('no longer active');
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

async function opened(ws: FakeSocket) {
  return Promise.all(
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
}

describe('cli-bridge page refuses frames it cannot handle', () => {
  it('an unknown frame type gets an error naming it', async () => {
    const ws = await start();
    await init(ws, {});

    await deliver(ws, { type: 'teleport' });

    await vi.waitFor(async () =>
      expect(await opened(ws)).toContainEqual({ type: 'error', reason: 'Unsupported message: teleport' })
    );
  });

  it('an init for an unsupported chain is refused, shows the reason and builds no SDK', async () => {
    const ws = await start();

    const reply = await init(ws, { chainId: 999999 });

    expect(reply).toEqual({ type: 'error', reason: 'Unsupported chainId: 999999' });
    expect(host.textContent).toContain('Unsupported chainId: 999999');
    expect(created.appNames).toEqual([]);
    expect(await opened(ws)).not.toContainEqual(expect.objectContaining({ type: 'ready' }));
  });

  it('an init with no chainId is refused instead of falling back to mainnet', async () => {
    const ws = await start();

    const reply = await init(ws, { chainId: undefined });

    expect(reply).toMatchObject({ type: 'error', reason: expect.stringContaining('chainId') });
    expect(created.appNames).toEqual([]);
  });

  it.each([
    ['ens', { ens: 5 }],
    ['appName', { appName: 5 }],
    ['apiKey', { apiKey: 5 }],
    ['paymasterUrl', { paymasterUrl: 'http://pm.example' }],
    ['paymasterContext', { paymasterContext: { token: '0x1' } }],
  ])('an init with a bad %s is refused and builds no SDK', async (field, payload) => {
    const ws = await start();

    const reply = await init(ws, payload);

    expect(reply).toMatchObject({ type: 'error', reason: expect.stringContaining(field) });
    expect(host.textContent).toContain(reply.reason);
    expect(created.appNames).toEqual([]);
  });

  it('a request whose method is not a non-empty string is refused and the wallet is not asked', async () => {
    const asked = vi.fn(async () => null);
    created.request = asked;
    const ws = await start();
    await init(ws, {});

    await deliver(ws, { type: 'rpc_request', id: 'm1', method: 7, params: [] });
    await deliver(ws, { type: 'rpc_request', id: 'm2', params: [] });

    await vi.waitFor(async () => expect(await answers(ws, 'm2')).toHaveLength(1));
    expect(await answers(ws, 'm1')).toEqual([
      { type: 'rpc_response', id: 'm1', success: false, error: { code: -32600, message: expect.any(String) } },
    ]);
    expect(asked).not.toHaveBeenCalled();
  });

  it('a request with one params value, as `jaw rpc` sends it, reaches the wallet as the first param', async () => {
    const asked = vi.fn(async () => null);
    created.request = asked;
    const ws = await start();
    await init(ws, {});

    await deliver(ws, { type: 'rpc_request', id: 'p1', method: 'wallet_sendCalls', params: { calls: [] } });

    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith({ method: 'wallet_sendCalls', params: [{ calls: [] }] }));
  });

  it('a request with no id is dropped without an answer', async () => {
    const asked = vi.fn(async () => null);
    created.request = asked;
    const error = vi.spyOn(console, 'error').mockReturnValue();
    const ws = await start();
    await init(ws, {});
    const sent = ws.sent.length;

    await deliver(ws, { type: 'rpc_request', method: 'eth_chainId', params: [] });

    expect(ws.sent).toHaveLength(sent);
    expect(asked).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a method the provider knows nothing about still reaches it, since the provider is the gate', async () => {
    const asked = vi.fn(async () => '0x1');
    created.request = asked;
    const ws = await start();
    await init(ws, {});

    await deliver(ws, { type: 'rpc_request', id: 'u1', method: 'eth_whatever', params: [] });

    await vi.waitFor(async () => expect(await answers(ws, 'u1')).toHaveLength(1));
    expect(asked).toHaveBeenCalledWith({ method: 'eth_whatever', params: [] });
  });

  it('a frame over 1 MiB is dropped before it is read', async () => {
    const error = vi.spyOn(console, 'error').mockReturnValue();
    const ws = await start();
    const sent = ws.sent.length;

    await act(async () => {
      await ws.onmessage!({ data: JSON.stringify({ type: 'ping', pad: 'x'.repeat(1_048_576) }) });
    });

    expect(ws.sent).toHaveLength(sent);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a frame just under the cap is still read', async () => {
    const ws = await start();
    const pad = 'x'.repeat(1_048_576 - 64);

    await act(async () => {
      await ws.onmessage!({ data: JSON.stringify({ type: 'ping', pad }) });
    });

    expect(ws.sent.at(-1)).toEqual({ type: 'pong' });
  });
});

describe('cli-bridge page proves the link secret', () => {
  const LINK_SECRET = Buffer.alloc(32, 9).toString('base64url');
  const hmac = (session: string, clientKey: string, pageKey: string) =>
    createHmac('sha256', Buffer.alloc(32, 9))
      .update(`jaw-bridge-key/1\n${session}\n${clientKey}\n${pageKey}`)
      .digest('hex');

  async function open(fragment: string, wrap: (el: React.ReactElement) => React.ReactElement = (el) => el) {
    const cli = (cliKeys = await generateKeyPair());
    const pk = await exportKeyToHexString('public', cli.publicKey);
    window.location.hash = `pk=${pk}${fragment}`;
    await act(async () => root.render(wrap(<CLIBridgePage />)));
    return { cli, pk };
  }

  it('given a link with no secret, the key exchange carries no proof', async () => {
    const { cli } = await open('');
    const ws = await connect(1, cli);

    expect(ws.sent[0].type).toBe('key_exchange');
    expect(ws.sent[0]).not.toHaveProperty('proof');
  });

  it('given a link with a secret, the key exchange proves it for this session and both keys', async () => {
    const { cli, pk } = await open(`&s=${LINK_SECRET}`);
    const ws = await connect(1, cli);

    const frame = ws.sent[0];
    expect(frame.proof).toBe(hmac('s1', pk, frame.publicKey as string));
  });

  it('given a link opened under StrictMode, each socket sends one key exchange with the valid proof', async () => {
    const { cli, pk } = await open(`&s=${LINK_SECRET}`, (el) => <StrictMode>{el}</StrictMode>);
    await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    await connect(FakeSocket.all.length, cli);

    for (const ws of FakeSocket.all) {
      const exchanges = ws.sent.filter((f) => f.type === 'key_exchange');
      if (ws.readyState === 1 && ws.sent.length > 0) {
        expect(exchanges).toHaveLength(1);
        expect(exchanges[0].proof).toBe(hmac('s1', pk, exchanges[0].publicKey as string));
      }
    }
    expect(host.textContent).not.toContain('damaged');
    expect(host.textContent).not.toContain('no longer active');
  });

  it('given a link read, the address has no fragment and the page does not show the secret', async () => {
    const { cli } = await open(`&s=${LINK_SECRET}`);
    await connect(1, cli);

    expect(window.location.hash).toBe('');
    expect(host.textContent).not.toContain(LINK_SECRET);
  });

  it.each([
    ['characters outside base64url', 'not-a-secret!'],
    ['a non-canonical encoding', Buffer.alloc(32, 9).toString('base64url').slice(0, -1) + 'd'],
  ])('given a secret with %s, the page says the link is damaged and connects nothing', async (_, s) => {
    await open(`&s=${encodeURIComponent(s)}`);

    expect(host.textContent).toContain('This link is damaged. Ask the agent for a new one.');
    expect(FakeSocket.all).toHaveLength(0);
    expect(window.location.hash).toBe('');
  });

  it('given a damaged secret under StrictMode, the page still says damaged', async () => {
    await open('&s=not-a-secret!', (el) => <StrictMode>{el}</StrictMode>);

    expect(host.textContent).toContain('This link is damaged. Ask the agent for a new one.');
    expect(host.textContent).not.toContain('no longer active');
  });

  it('given a secret and no key, the page says the link is no longer active and clears the fragment', async () => {
    window.location.hash = `s=${LINK_SECRET}`;
    await act(async () => root.render(<CLIBridgePage />));

    expect(host.textContent).toContain('This link is no longer active. Ask the agent for a new one.');
    expect(FakeSocket.all).toHaveLength(0);
    expect(window.location.hash).toBe('');
  });
});
