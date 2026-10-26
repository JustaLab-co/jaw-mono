import type { AddressInfo } from 'node:net';
import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  exportKeyToHex,
  generateKeyPair,
  importKeyFromHex,
  type EncryptedEnvelope,
} from '@jaw.id/agent';
import WebSocket, { WebSocketServer } from 'ws';
import { canonical } from '@/lib/canonical';
import { ownerRelay, type OpenWallet } from './relay';

export async function startRelay() {
  const seen: string[] = [];
  const fromServer = new Map<string, number>();
  const sessions = new Map<string, { cli?: WebSocket; browser?: WebSocket }>();
  const silent = new Set<string>();
  const refused = new Set<string>();
  const cliWaiters = new Map<string, () => void>();
  const dropped = new Set<string>();
  const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  relay.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'ws://relay');
    const id = url.searchParams.get('session')!;
    const role = url.searchParams.get('role') as 'cli' | 'browser';
    const pair = sessions.get(id) ?? {};
    if (refused.has(id)) return ws.close();
    // As jaw-relay does, a second cli replaces the first.
    if (role === 'cli') pair.cli?.close(4003, 'replaced');
    // And a second browser cuts the first off, so the page the owner left hears nothing more and cannot answer.
    if (role === 'browser' && pair.browser?.readyState === WebSocket.OPEN) {
      pair.browser.close(4003, 'Replaced by new browser connection');
    }
    pair[role] = ws;
    sessions.set(id, pair);
    if (role === 'cli') cliWaiters.get(id)?.();
    if (role === 'cli' && dropped.has(id)) {
      delete pair.cli;
      ws.terminate();
      return;
    }
    if (role === 'browser') pair.cli?.send(JSON.stringify({ type: 'browser_connected' }));
    if (role === 'cli' && !silent.has(id))
      ws.send(JSON.stringify({ type: 'status', browserConnected: pair.browser?.readyState === WebSocket.OPEN }));
    ws.on('close', () => {
      if (pair[role] === ws) delete pair[role];
    });
    ws.on('message', (data) => {
      seen.push(String(data));
      if (role === 'cli') fromServer.set(id, (fromServer.get(id) ?? 0) + 1);
      const to = role === 'cli' ? pair.browser : pair.cli;
      if (to?.readyState === WebSocket.OPEN) to.send(String(data));
    });
  });
  await new Promise((r) => relay.once('listening', r));
  return {
    url: `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    seen,
    fromServer,
    sessions,
    silent,
    refused,
    /** Resolves once this server's side of the session reached the relay. */
    cliJoined: (id: string) =>
      sessions.get(id)?.cli ? Promise.resolve() : new Promise<void>((r) => cliWaiters.set(id, r)),
    dropped,
    close: () => relay.close(),
  };
}

export async function replayingPage(
  link: string,
  owner: (method: string, params: unknown) => Promise<unknown>,
  { replays = true } = {}
) {
  const url = new URL(link);
  const keys = await generateKeyPair();
  const secret = await deriveSharedSecret(
    keys.privateKey,
    await importKeyFromHex('public', url.hash.slice('#pk='.length))
  );
  const publicKey = await exportKeyToHex('public', keys.publicKey);
  const ws = new WebSocket(`${url.searchParams.get('relay')}?session=${url.searchParams.get('session')}&role=browser`);
  // The frames of its answers as the relay carries them, so a test can tell when one went past.
  const answered: string[] = [];
  const send = async (payload: Record<string, unknown>) => {
    const frame = JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) });
    if (payload.type === 'rpc_response') answered.push(frame);
    ws.send(frame);
  };
  const answers = new Map<string, { request: string; reply: Promise<object> }>();
  const ids: string[] = [];
  const sent: Record<string, unknown>[] = [];
  let mute = false;
  let closedWith: number | undefined;
  ws.on('close', (code) => (closedWith = code));
  let shut!: () => void;
  // Settles when this server's last frame reached the page, so every frame before it went through the relay too.
  const shutdown = new Promise<void>((resolve) => (shut = resolve));
  ws.on('message', async (data) => {
    const inner = await decryptMessage(secret, JSON.parse(String(data)) as EncryptedEnvelope).catch(() => undefined);
    if (inner?.type === 'shutdown') shut();
    if (inner?.type === 'init') sent.push(inner);
    if (inner?.type === 'init' && !mute) await send({ type: 'ready', replays });
    if (inner?.type !== 'rpc_request') return;
    const id = String(inner.id);
    ids.push(id);
    const request = canonical([inner.method, inner.params]);
    if (!answers.has(id)) {
      const reply = owner(String(inner.method), inner.params).then(
        (data) => ({ success: true, data }),
        (err: { code?: number; message?: string }) => ({
          success: false,
          error: { code: err.code, message: err.message },
        })
      );
      answers.set(id, { request, reply });
    }
    const first = answers.get(id)!;
    const reply =
      first.request === request
        ? await first.reply
        : { success: false, error: { code: -32600, message: 'not the request' } };
    await send({ type: 'rpc_response', id, ...reply });
  });
  await new Promise((r) => ws.once('open', r));
  const greet = () => ws.send(JSON.stringify({ type: 'key_exchange', publicKey }));
  greet();
  return {
    publicKey,
    ids,
    answered,
    asked: () => answers.size,
    inits: () => sent.length,
    lastInit: () => sent.at(-1),
    /** Sends the same key again on the same socket. */
    greet,
    /** Sends `frame` as it is on the same socket, the way a page that misbehaves would. */
    raw: (frame: Record<string, unknown>) => ws.send(JSON.stringify(frame)),
    /** The code the socket was closed with, once it is closed. */
    closedWith: () => closedWith,
    shutdown,
    mute: () => (mute = true),
    close: () => ws.close(),
  };
}

export function stallsAfter(n: number) {
  let wake!: (err?: unknown, late?: unknown) => void;
  const woken = new Promise<unknown>((resolve, reject) => (wake = (err, late) => (err ? reject(err) : resolve(late))));
  let closed = false;
  const openWallet: OpenWallet = async (chainId, until, client) => {
    const wallet = await ownerRelay(chainId, until, client);
    return {
      url: wallet.url,
      close: () => {
        closed = true;
        wallet.close();
      },
      run: (work, joined) =>
        wallet.run((ask) => {
          let sent = 0;
          return work(async (method, params) => {
            if (++sent < n) return ask(method, params);
            const answer = ask(method, params);
            answer.catch(() => undefined);
            const late = await woken;
            return late === undefined ? answer : late;
          });
        }, joined),
    };
  };
  return { openWallet, wake, closed: () => closed };
}
