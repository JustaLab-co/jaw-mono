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
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { useTestDb } from '@/db/test-db';
import type { RelayResume } from './seal';
import { setTestEnv } from './testkit';

// A relay that pairs the two roles of a session and forwards what each sends, as relay.jaw.id does.
const seen: string[] = [];
const fromServer = new Map<string, number>();
const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
const sessions = new Map<string, { cli?: WebSocket; browser?: WebSocket }>();
const silent = new Set<string>();
const dropped = new Set<string>();
relay.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'ws://relay');
  const id = url.searchParams.get('session')!;
  const role = url.searchParams.get('role') as 'cli' | 'browser';
  const pair = sessions.get(id) ?? {};
  pair[role] = ws;
  sessions.set(id, pair);
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

setTestEnv();
process.env.JAW_RELAY_URL = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
process.env.JAW_MCP_API_KEY = 'server-secret-key';
const { appNameOf, connectRelay, ownerRelay, PageGone, resumeWallet, SESSION_LIMITS, WalletBusy } = await import(
  './relay'
);
const openRelay = (chainId: number, ms = 30_000, client?: { clientId: string; clientName: string }) =>
  ownerRelay(chainId, new Date(Date.now() + ms), client);
afterAll(() => relay.close());

type Answer = (method: string, params: unknown) => { success: true; data: unknown } | { success: false; error: object };

/** The cli-bridge page: opens the link, agrees the key, answers init and each request, and records the shutdown. */
async function page(link: string, answer: Answer, onInit?: (inner: Record<string, unknown>) => object) {
  const url = new URL(link);
  const keys = await generateKeyPair();
  const secret = await deriveSharedSecret(
    keys.privateKey,
    await importKeyFromHex('public', url.hash.slice('#pk='.length))
  );
  const ws = new WebSocket(`${url.searchParams.get('relay')}?session=${url.searchParams.get('session')}&role=browser`);
  const send = async (payload: Record<string, unknown>) =>
    ws.send(JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) }));
  const inits: Record<string, unknown>[] = [];
  let pings = 0;
  const shutdown = new Promise<void>((resolve) => {
    ws.on('message', async (data) => {
      const msg = JSON.parse(String(data)) as { type: string };
      if (msg.type === 'ping') {
        pings++;
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      const inner = await decryptMessage(secret, msg as unknown as EncryptedEnvelope);
      if (inner.type === 'init') {
        inits.push(inner);
        await send(onInit ? (onInit(inner) as Record<string, unknown>) : { type: 'ready' });
      }
      if (inner.type === 'rpc_request')
        await send({ type: 'rpc_response', id: inner.id, ...answer(String(inner.method), inner.params) });
      if (inner.type === 'shutdown') resolve();
    });
  });
  ws.on('open', async () =>
    ws.send(JSON.stringify({ type: 'key_exchange', publicKey: await exportKeyToHex('public', keys.publicKey) }))
  );
  return { inits, shutdown, pings: () => pings };
}

describe('a wallet session over the relay', () => {
  it('runs each request through the cli-bridge page, then closes the page', async () => {
    const wallet = await openRelay(84532);
    expect(new URL(wallet.url).pathname).toBe('/cli-bridge');
    const opened = await page(wallet.url, () => ({
      success: true,
      data: ['0x00000000000000000000000000000000000000aa'],
    }));
    const accounts = await wallet.run((ask) => ask('eth_requestAccounts', []));
    expect(accounts).toEqual(['0x00000000000000000000000000000000000000aa']);
    await opened.shutdown;
    expect(opened.inits).toEqual([{ type: 'init', chainId: 84532, appName: 'JAW MCP' }]);
  });

  it("carries no key: the page takes its own deployment's, and the server's never leaves it", async () => {
    const wallet = await openRelay(84532);
    const opened = await page(wallet.url, () => ({ success: true, data: [] }));
    await wallet.run((ask) => ask('eth_requestAccounts', []));
    await opened.shutdown;
    expect(opened.inits[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(opened.inits)).not.toContain('server-secret-key');
  });

  it('given nobody opens the link before its deadline, then the session ends refused', async () => {
    const wallet = await openRelay(84532, 300);
    await expect(wallet.run((ask) => ask('eth_requestAccounts', []))).rejects.toThrow();
  });

  it('given the caller closes the session before handing out its link, then running it is refused', async () => {
    const wallet = await openRelay(84532);
    wallet.close();
    await expect(wallet.run((ask) => ask('eth_requestAccounts', []))).rejects.toThrow(
      /the relay connection failed|the wallet session ended/
    );
  });

  it('keeps the key out of what the relay sees: the public key rides the fragment, every message is ciphertext', async () => {
    const wallet = await openRelay(84532);
    expect(new URL(wallet.url).search).not.toContain('pk=');
    const opened = await page(wallet.url, () => ({ success: true, data: 'secret-answer' }));
    await wallet.run((ask) => ask('personal_sign', ['0x68656c6c6f', '0xaa']));
    await opened.shutdown;
    const relayed = seen.join('\n');
    expect(relayed).not.toContain('personal_sign');
    expect(relayed).not.toContain('secret-answer');
  });

  it('given the owner refuses in the wallet, then the caller gets the refusal and its code', async () => {
    const wallet = await openRelay(84532);
    await page(wallet.url, () => ({ success: false, error: { code: 4001, message: 'User rejected the request' } }));
    await expect(wallet.run((ask) => ask('wallet_grantPermissions', [{}]))).rejects.toMatchObject({
      message: 'User rejected the request',
      code: 4001,
    });
  });

  it('given the page cannot start, then the caller gets the reason it gave', async () => {
    const wallet = await openRelay(84532);
    await page(
      wallet.url,
      () => ({ success: true, data: null }),
      () => ({ type: 'error', reason: 'No API key' })
    );
    await expect(wallet.run((ask) => ask('eth_requestAccounts', []))).rejects.toThrow(
      'the wallet page refused: No API key'
    );
  });
});

/** A page that first sends what it should not: a key that is not a string, and an answer to a request nobody made. */
async function rogue(link: string, opts: { badKey?: boolean; stale?: boolean }) {
  const url = new URL(link);
  const keys = await generateKeyPair();
  const secret = await deriveSharedSecret(
    keys.privateKey,
    await importKeyFromHex('public', url.hash.slice('#pk='.length))
  );
  const ws = new WebSocket(`${url.searchParams.get('relay')}?session=${url.searchParams.get('session')}&role=browser`);
  const send = async (payload: Record<string, unknown>) =>
    ws.send(JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) }));
  ws.on('message', async (data) => {
    const inner = await decryptMessage(secret, JSON.parse(String(data)) as EncryptedEnvelope);
    if (inner.type === 'init') await send({ type: 'ready' });
    if (inner.type === 'rpc_request') {
      if (opts.stale) await send({ type: 'rpc_response', id: 'someone-else', success: true, data: 'stale' });
      await send({ type: 'rpc_response', id: inner.id, success: true, data: 'real' });
    }
  });
  ws.on('open', async () => {
    if (opts.badKey) ws.send(JSON.stringify({ type: 'key_exchange', publicKey: 42 }));
    ws.send(JSON.stringify({ type: 'key_exchange', publicKey: await exportKeyToHex('public', keys.publicKey) }));
  });
}

describe('a link the owner opens late', () => {
  // relay.jaw.id ends a session after 15 minutes without a message from either side.
  const RELAY_IDLE_MS = 15 * 60_000;
  afterEach(() => vi.useRealTimers());

  it('given nobody opens it for longer than the relay idle limit, then the server speaks at least twice per idle window and the session still runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wallet = await openRelay(84532, 40 * 60_000);
    const session = new URL(wallet.url).searchParams.get('session')!;
    const heard = () => fromServer.get(session) ?? 0;
    await vi.waitFor(() => expect(sessions.get(session)?.cli).toBeDefined());
    await new Promise((r) => setTimeout(r, 100));

    for (let window = 0; window < 4; window++) {
      const before = heard();
      await vi.advanceTimersByTimeAsync(RELAY_IDLE_MS / 2);
      await vi.waitFor(() => expect(heard()).toBeGreaterThan(before));
    }
    const opened = await page(wallet.url, () => ({
      success: true,
      data: ['0x00000000000000000000000000000000000000aa'],
    }));
    await vi.waitFor(() => expect(sessions.get(session)?.browser).toBeDefined());
    await vi.advanceTimersByTimeAsync(RELAY_IDLE_MS - 1_000);
    await vi.waitFor(() => expect(opened.pings()).toBeGreaterThan(0));

    expect(await wallet.run((ask) => ask('eth_requestAccounts', []))).toEqual([
      '0x00000000000000000000000000000000000000aa',
    ]);
    await opened.shutdown;
  });

  it('given the session is closed, then it leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const wallet = await openRelay(84532, 40 * 60_000);
    const session = new URL(wallet.url).searchParams.get('session')!;
    await vi.waitFor(() => expect(sessions.get(session)?.cli).toBeDefined());
    wallet.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a session nobody opens for ten minutes', () => {
  const JOIN_MS = 10 * 60_000;
  afterEach(() => vi.useRealTimers());

  it('given no browser joins within ten minutes, then the session ends saying so and its slot opens another', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.resetModules();
    const fresh = await import('./relay');
    const until = new Date(Date.now() + 30 * 60_000);
    const held = await Promise.all(
      Array.from({ length: fresh.SESSION_LIMITS.connect }, () => fresh.connectRelay(84532, until))
    );
    const ids = held.map((w) => new URL(w.url).searchParams.get('session')!);
    await vi.waitFor(() => expect(ids.every((id) => sessions.get(id)?.cli)).toBe(true));
    await expect(fresh.connectRelay(84532, until)).rejects.toBeInstanceOf(fresh.WalletBusy);
    const ended = held[0].run(async () => 'ran').catch((err: Error) => err.message);

    await vi.advanceTimersByTimeAsync(JOIN_MS - 1_000);
    await expect(fresh.connectRelay(84532, until)).rejects.toBeInstanceOf(fresh.WalletBusy);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await ended).toBe('the wallet link was not opened in time');
    expect((await fresh.connectRelay(84532, until)).url).toMatch(/cli-bridge/);
  });

  it('given the browser joined, then the session runs past ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const wallet = await connectRelay(84532, new Date(Date.now() + 30 * 60_000));
    const session = new URL(wallet.url).searchParams.get('session')!;
    const opened = await page(wallet.url, () => ({
      success: true,
      data: ['0x00000000000000000000000000000000000000bb'],
    }));
    await vi.waitFor(() => expect(sessions.get(session)?.browser).toBeDefined());
    await new Promise((r) => setImmediate(r));

    await vi.advanceTimersByTimeAsync(2 * JOIN_MS);

    expect(await wallet.run((ask) => ask('eth_requestAccounts', []))).toEqual([
      '0x00000000000000000000000000000000000000bb',
    ]);
    await opened.shutdown;
  });
  it('given a tool link nobody opens for ten minutes, then it still runs once the owner opens it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const wallet = await openRelay(84532, 30 * 60_000);
    const session = new URL(wallet.url).searchParams.get('session')!;
    await vi.waitFor(() => expect(sessions.get(session)?.cli).toBeDefined());

    await vi.advanceTimersByTimeAsync(2 * JOIN_MS);
    const opened = await page(wallet.url, () => ({
      success: true,
      data: ['0x00000000000000000000000000000000000000cc'],
    }));

    expect(await wallet.run((ask) => ask('eth_requestAccounts', []))).toEqual([
      '0x00000000000000000000000000000000000000cc',
    ]);
    await opened.shutdown;
  });
});

describe('what the wallet page can get wrong', () => {
  it('given a refusal with no code, then the caller gets the message and no code', async () => {
    const wallet = await openRelay(84532);
    await page(wallet.url, () => ({ success: false, error: { message: 'boom' } }));

    const err = await wallet.run((ask) => ask('eth_requestAccounts', [])).catch((e: unknown) => e);

    expect(err).toMatchObject({ message: 'boom' });
    expect((err as { code?: number }).code).toBeUndefined();
  });

  it('given an answer to another request first, then it is not taken for the answer', async () => {
    const wallet = await openRelay(84532);
    await rogue(wallet.url, { stale: true });

    expect(await wallet.run((ask) => ask('eth_requestAccounts', []))).toBe('real');
  });

  it('given a key exchange whose key is not a string, then it is ignored', async () => {
    const wallet = await openRelay(84532);
    await rogue(wallet.url, { badKey: true });

    expect(await wallet.run((ask) => ask('eth_requestAccounts', []))).toBe('real');
  });

  it('given nobody opens the link before its deadline, then the caller is told it timed out', async () => {
    const wallet = await openRelay(84532, 300);
    await expect(wallet.run((ask) => ask('eth_requestAccounts', []))).rejects.toThrow(
      'timed out waiting for the wallet'
    );
  });
});

describe('the pool of sessions', () => {
  // A pool is process-wide, so each test fills its own copy of the module.
  const fresh = () => {
    vi.resetModules();
    return import('./relay');
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const opensAgain = (relay: Awaited<ReturnType<typeof fresh>>, ms = 500) =>
    vi.waitFor(
      async () => expect((await relay.ownerRelay(84532, new Date(Date.now() + ms))).url).toMatch(/cli-bridge/),
      { timeout: 3_000 }
    );

  it('given authorizations beyond the owner limit, then all of them open', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 3_000);
    const count = relay.SESSION_LIMITS.owner + 10;
    const held = await Promise.all(Array.from({ length: count }, () => relay.connectRelay(84532, until)));
    expect(held).toHaveLength(count);
  });

  it('given the owner pool is full, then a further session is busy until one closes', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    const held = [];
    for (let i = 0; i < relay.SESSION_LIMITS.owner; i++) held.push(await relay.ownerRelay(84532, until));
    await expect(relay.ownerRelay(84532, until)).rejects.toBeInstanceOf(relay.WalletBusy);
    await sleep(500);

    held[0].close();

    await opensAgain(relay);
  });

  it('given a session that ran to its end, then its slot is free at once', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 20_000);
    for (let i = 0; i < relay.SESSION_LIMITS.owner - 1; i++) await relay.ownerRelay(84532, until);
    const last = await relay.ownerRelay(84532, until);
    await page(last.url, () => ({ success: true, data: [] }));
    await last.run((ask) => ask('eth_requestAccounts', []));

    await opensAgain(relay);
  });

  it('given sessions nobody runs, then their slots are free at their deadline', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 700);
    for (let i = 0; i < relay.SESSION_LIMITS.owner; i++) await relay.ownerRelay(84532, until);
    await expect(relay.ownerRelay(84532, until)).rejects.toBeInstanceOf(relay.WalletBusy);
    await sleep(300);

    await opensAgain(relay);
  });

  it('given sessions closed before their socket opened, then their slots are free', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    for (let i = 0; i < relay.SESSION_LIMITS.owner; i++) (await relay.ownerRelay(84532, until)).close();
    await sleep(800);

    const opened = [];
    for (let i = 0; i < relay.SESSION_LIMITS.owner; i++) opened.push(await relay.ownerRelay(84532, until));
    expect(opened).toHaveLength(relay.SESSION_LIMITS.owner);
  });

  it('given a session closed twice, then it frees one slot', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    const held = [];
    for (let i = 0; i < relay.SESSION_LIMITS.owner; i++) held.push(await relay.ownerRelay(84532, until));
    held[0].close();
    held[0].close();
    await sleep(500);

    await relay.ownerRelay(84532, until);
    await expect(relay.ownerRelay(84532, until)).rejects.toBeInstanceOf(relay.WalletBusy);
  });

  it('given more sessions asked for at once than the limit, then only the limit opens', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 5_000);

    const results = await Promise.allSettled(Array.from({ length: 60 }, () => relay.ownerRelay(84532, until)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(relay.SESSION_LIMITS.owner);
  });
});

describe('the owner pool per account', () => {
  const fresh = () => {
    vi.resetModules();
    return import('./relay');
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ACCOUNT = '0xAbCdEf0000000000000000000000000000000001';
  const OTHER = '0x0000000000000000000000000000000000000002';
  const as = (account: string) => ({ clientId: 'c', clientName: 'c', account });
  type Relay = Awaited<ReturnType<typeof fresh>>;
  const fill = async (relay: Relay, account: string, until: Date) => {
    const held = [];
    for (let i = 0; i < relay.SESSION_LIMITS.ownerPerAccount; i++) {
      held.push(await relay.ownerRelay(84532, until, as(account)));
    }
    return held;
  };
  const busy = (relay: Relay, account: string, until: Date) =>
    expect(relay.ownerRelay(84532, until, as(account))).rejects.toBeInstanceOf(relay.WalletBusy);
  const opensAgain = (relay: Relay, account: string) =>
    vi.waitFor(
      async () =>
        expect((await relay.ownerRelay(84532, new Date(Date.now() + 500), as(account))).url).toMatch(/cli-bridge/),
      { timeout: 3_000 }
    );

  it('given an account holds its share, then a further session for it is busy', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    await fill(relay, ACCOUNT, until);

    await busy(relay, ACCOUNT, until);
  });

  it('given the share is held, then the same address in another case is busy too', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    await fill(relay, ACCOUNT, until);

    await busy(relay, ACCOUNT.toLowerCase(), until);
  });

  it('given one account is full, then another account and a session with no account still open', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    await fill(relay, ACCOUNT, until);

    expect((await relay.ownerRelay(84532, until, as(OTHER))).url).toMatch(/cli-bridge/);
    expect((await relay.ownerRelay(84532, until)).url).toMatch(/cli-bridge/);
  });

  it('given an account is full, then the authorization pool is not limited by it', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    await fill(relay, ACCOUNT, until);

    const held = [];
    for (let i = 0; i < relay.SESSION_LIMITS.ownerPerAccount + 1; i++) {
      held.push(await relay.connectRelay(84532, until, as(ACCOUNT)));
    }

    expect(held).toHaveLength(relay.SESSION_LIMITS.ownerPerAccount + 1);
  });

  it('given a session closed, then only that account gets the slot back', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    const held = await fill(relay, ACCOUNT, until);
    await fill(relay, OTHER, until);
    held[0].close();
    await sleep(300);

    await opensAgain(relay, ACCOUNT);
    await busy(relay, OTHER, until);
  });

  it('given a session that ran to its end, then its slot is free at once', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 20_000);
    const held = await fill(relay, ACCOUNT, until);
    await page(held[0].url, () => ({ success: true, data: [] }));
    await held[0].run((ask) => ask('eth_requestAccounts', []));

    await opensAgain(relay, ACCOUNT);
  });

  it('given sessions nobody runs, then the slots are free at their deadline', async () => {
    const relay = await fresh();
    await fill(relay, ACCOUNT, new Date(Date.now() + 600));
    await busy(relay, ACCOUNT, new Date(Date.now() + 600));
    await sleep(300);

    await opensAgain(relay, ACCOUNT);
  });

  it('given sessions closed before their socket opened, then the slots are free', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    for (const wallet of await fill(relay, ACCOUNT, until)) wallet.close();
    await sleep(500);

    expect(await fill(relay, ACCOUNT, until)).toHaveLength(relay.SESSION_LIMITS.ownerPerAccount);
  });

  it('given a session closed twice, then it frees one slot', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 8_000);
    const held = await fill(relay, ACCOUNT, until);
    held[0].close();
    held[0].close();
    await sleep(500);

    await relay.ownerRelay(84532, until, as(ACCOUNT));
    await busy(relay, ACCOUNT, until);
  });

  it('given more sessions asked for at once than the share, then only the share opens', async () => {
    const relay = await fresh();
    const until = new Date(Date.now() + 5_000);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => relay.ownerRelay(84532, until, as(ACCOUNT)))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(relay.SESSION_LIMITS.ownerPerAccount);
  });

  it('given the account is full, then jaw_grant_permissions answers busy instead of throwing', async () => {
    await useTestDb();
    const relay = await fresh();
    const { grantPermissions } = await import('../tools/grant-permissions');
    const until = new Date(Date.now() + 8_000);
    await fill(relay, ACCOUNT, until);
    const t = {
      ...as(ACCOUNT),
      connectionId: 'conn',
      chainId: 84532,
      sessionAddress: OTHER,
      scopes: [],
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    const result = await grantPermissions(
      t as never,
      { x402Budget: { perDay: '1' } },
      {
        openWallet: relay.ownerRelay,
        readPermission: async () => null as never,
      }
    );

    expect(result.content[0].text).toBe('Too many owners are approving right now. Try again in a minute.');
  });
});

describe('given authorizations hold every session of their pool', () => {
  it("when the owner's tools ask for a session, then theirs still opens, and a further authorization is busy", async () => {
    const until = new Date(Date.now() + 1_000);
    const held = await Promise.all(Array.from({ length: SESSION_LIMITS.connect }, () => connectRelay(84532, until)));
    expect(held).toHaveLength(SESSION_LIMITS.connect);

    await expect(connectRelay(84532, until)).rejects.toBeInstanceOf(WalletBusy);
    expect((await ownerRelay(84532, until)).url).toMatch(/cli-bridge/);
  });

  describe('appNameOf', () => {
    const VIA = ' (via JAW MCP)';
    const named = (clientName: string, clientId = 'https://agent.example/client.json') =>
      appNameOf({ clientId, clientName });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
      'given the client id %s, then it is not taken for a first-party client',
      (clientId) => {
        expect(named('Evil Agent', clientId)).toBe(`Evil Agent${VIA}`);
      }
    );

    it('given invisible characters between spaces, then one space is left', () => {
      expect(named('A \u200b B')).toBe(`A B${VIA}`);
      expect(named('A \u200b\u200b \u202e B')).toBe(`A B${VIA}`);
    });

    it('given a format character outside the default-ignorable set, then it is dropped', () => {
      expect(named('A\u0600B')).toBe(`AB${VIA}`);
    });

    it('given a default-ignorable letter, then it is dropped', () => {
      expect(named('A\u3164B')).toBe(`AB${VIA}`);
    });

    it('given tabs and newlines between words, then each run becomes one space', () => {
      expect(named('A\t\nB')).toBe(`A B${VIA}`);
      expect(named('A \r\n\t B')).toBe(`A B${VIA}`);
    });

    it('given a line separator between words, then it is one space like on the keys page', () => {
      expect(named('A\u2028B')).toBe(`A B${VIA}`);
    });

    it('given a name that is only invisible characters, then it falls back to JAW MCP', () => {
      expect(named('\u0600\u3164 \t')).toBe('JAW MCP');
    });

    it('given a cut that lands after a space, then no space is left before the suffix', () => {
      const name = named(`${'a'.repeat(49)} b`);
      expect(name).toBe(`${'a'.repeat(49)}${VIA}`);
    });

    it('given a name of emoji, then the cut keeps whole code points and the suffix intact', () => {
      const name = named('\u{1F600}'.repeat(60));
      expect(name).toBe(`${'\u{1F600}'.repeat(50)}${VIA}`);
      expect(Array.from(name)).toHaveLength(64);
    });
  });

  describe('the app name the page shows', () => {
    const initOf = async (client?: { clientId: string; clientName: string }) => {
      const wallet = await openRelay(84532, 30_000, client);
      const opened = await page(wallet.url, () => ({ success: true, data: [] }));
      await wallet.run((ask) => ask('eth_requestAccounts', []));
      await opened.shutdown;
      return opened.inits[0];
    };

    it('names a registered client and marks the name as its own claim', async () => {
      const init = await initOf({ clientId: 'https://agent.example/client.json', clientName: 'Example Agent' });
      expect(init).toEqual({ type: 'init', chainId: 84532, appName: 'Example Agent (via JAW MCP)' });
    });

    it('names a first-party client by its known name, whatever the row holds, still marked as via the server', async () => {
      const init = await initOf({ clientId: 'jaw-cli', clientName: 'something else' });
      expect(init?.appName).toBe('JAW CLI (via JAW MCP)');
    });

    it('falls back to JAW MCP when there is no client or the name is empty', async () => {
      expect((await initOf())?.appName).toBe('JAW MCP');
      expect((await initOf({ clientId: 'x', clientName: ' \u200b\n ' }))?.appName).toBe('JAW MCP');
    });

    it('strips control and direction characters and keeps the whole string within 64 characters', async () => {
      const dirty = await initOf({ clientId: 'x', clientName: 'Ev\u0000il\u202e\n Agent\u200b' });
      expect(dirty?.appName).toBe('Evil Agent (via JAW MCP)');
      const long = await initOf({ clientId: 'x', clientName: 'A'.repeat(200) });
      expect(String(long?.appName)).toHaveLength(64);
      expect(String(long?.appName)).toMatch(/^A+ \(via JAW MCP\)$/);
    });
  });
});

async function replayingPage(link: string, owner: () => Promise<unknown>) {
  const url = new URL(link);
  const keys = await generateKeyPair();
  const secret = await deriveSharedSecret(
    keys.privateKey,
    await importKeyFromHex('public', url.hash.slice('#pk='.length))
  );
  const publicKey = await exportKeyToHex('public', keys.publicKey);
  const ws = new WebSocket(`${url.searchParams.get('relay')}?session=${url.searchParams.get('session')}&role=browser`);
  const send = async (payload: Record<string, unknown>) =>
    ws.send(JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) }));
  const answers = new Map<string, { request: string; reply: Promise<object> }>();
  const ids: string[] = [];
  let inits = 0;
  let mute = false;
  ws.on('message', async (data) => {
    const inner = await decryptMessage(secret, JSON.parse(String(data)) as EncryptedEnvelope).catch(() => undefined);
    if (inner?.type === 'init') inits++;
    if (inner?.type === 'init' && !mute) await send({ type: 'ready', replays: true });
    if (inner?.type !== 'rpc_request') return;
    const id = String(inner.id);
    ids.push(id);
    const request = JSON.stringify([inner.method, inner.params]);
    if (!answers.has(id)) answers.set(id, { request, reply: owner().then((data) => ({ success: true, data })) });
    const first = answers.get(id)!;
    const reply =
      first.request === request
        ? await first.reply
        : { success: false, error: { code: -32600, message: 'not the request' } };
    await send({ type: 'rpc_response', id, ...reply });
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'key_exchange', publicKey }));
  return {
    publicKey,
    ids,
    asked: () => answers.size,
    inits: () => inits,
    mute: () => (mute = true),
    close: () => ws.close(),
  };
}

const sign = (ask: (method: string, params: unknown[]) => Promise<unknown>) => ask('personal_sign', ['0x68', '0xaa']);
const never = () => new Promise<never>(() => {});
const soon = () => new Date(Date.now() + 60_000);

async function restarted(owner: () => Promise<unknown>) {
  const wallet = await openRelay(84532, 60_000);
  const opened = await replayingPage(wallet.url, owner);
  let resume: RelayResume | undefined;
  const first = wallet.run(sign, (r) => {
    resume = r;
  });
  await vi.waitFor(() => expect(opened.ids).toHaveLength(1));
  wallet.close();
  await first.catch(() => undefined);
  return { wallet, opened, resume: resume! };
}

describe('a session the server can rejoin', () => {
  afterEach(() => vi.useRealTimers());

  it('given a page that replays, when it is ready, then joined gets the session, the page key and the init, before the first ask', async () => {
    const wallet = await openRelay(84532, 30_000, { clientId: 'x', clientName: 'Agent' });
    const opened = await replayingPage(wallet.url, async () => '0xsig');
    const joined: { resume: RelayResume; asked: number }[] = [];

    await wallet.run(sign, (resume) => {
      joined.push({ resume, asked: opened.ids.length });
    });

    expect(joined).toHaveLength(1);
    expect(joined[0].asked).toBe(0);
    expect(joined[0].resume).toMatchObject({
      session: new URL(wallet.url).searchParams.get('session'),
      peer: opened.publicKey,
      chainId: 84532,
      appName: 'Agent (via JAW MCP)',
    });
  });

  it('given a page that does not say it replays, then joined never fires and the run still answers', async () => {
    const wallet = await openRelay(84532);
    await page(wallet.url, () => ({ success: true, data: '0xsig' }));
    const joined = vi.fn();

    expect(await wallet.run(sign, joined)).toBe('0xsig');
    expect(joined).not.toHaveBeenCalled();
  });

  it('given two asks in a run, then their ids are the session and the count from zero', async () => {
    const wallet = await openRelay(84532);
    const opened = await replayingPage(wallet.url, async () => '0xsig');
    const session = new URL(wallet.url).searchParams.get('session');

    await wallet.run(async (ask) => [await sign(ask), await sign(ask)]);

    expect(opened.ids).toEqual([`${session}:0`, `${session}:1`]);
  });

  it.each(['while the server was down', 'after the server rejoined'])(
    'given the server restarted while the owner was deciding, when the owner answers %s, then the rejoined server collects that answer and the owner was asked once',
    async (when) => {
      let approve!: (sig: string) => void;
      const decided = new Promise((r) => (approve = r));
      const { wallet, opened, resume } = await restarted(() => decided);
      if (when === 'while the server was down') approve('0xsig');

      const resumed = await resumeWallet(resume, soon());
      expect(resumed?.url).toBe(wallet.url);
      const answer = resumed!.run(sign);
      await vi.waitFor(() => expect(opened.ids).toHaveLength(2));
      approve('0xsig');

      expect(await answer).toBe('0xsig');
      expect(opened.ids).toEqual([`${resume.session}:0`, `${resume.session}:0`]);
      expect(opened.asked()).toBe(1);
    }
  );

  it('given the page was closed, when the server rejoins, then there is no wallet to resume', async () => {
    const { opened, resume } = await restarted(never);
    opened.close();
    await vi.waitFor(() => expect(sessions.get(resume.session)?.browser).toBeUndefined());

    expect(await resumeWallet(resume, soon())).toBeUndefined();
    await vi.waitFor(() => expect(sessions.get(resume.session)?.cli).toBeUndefined());
  });

  it('given the relay sends no status, when 15 seconds pass, then there is no wallet to resume', async () => {
    const { resume } = await restarted(never);
    silent.add(resume.session);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const resumed = resumeWallet(resume, soon());
    await vi.waitFor(() => expect(sessions.get(resume.session)?.cli?.readyState).toBe(WebSocket.OPEN));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await resumed).toBeUndefined();
    vi.useRealTimers();
    await vi.waitFor(() => expect(sessions.get(resume.session)?.cli).toBeUndefined());
  });

  it('given the relay connection fails during the rejoin, then it throws instead of saying the page is gone', async () => {
    const { resume } = await restarted(never);
    dropped.add(resume.session);

    await expect(resumeWallet(resume, soon())).rejects.toThrow();
    await vi.waitFor(() => expect(sessions.get(resume.session)?.cli).toBeUndefined());
  });

  it('given joined never settles, when 5 seconds pass, then the run goes on without being saved and warns', async () => {
    const wallet = await openRelay(84532);
    const opened = await replayingPage(wallet.url, async () => '0xsig');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const run = wallet.run(sign, never);
    await vi.waitFor(() => expect(opened.inits()).toBe(1));
    await new Promise((r) => setImmediate(r));
    expect(opened.ids).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await run).toBe('0xsig');
    expect(logged.mock.calls.flat().join('\n')).toContain('relay session not saved');
    logged.mockRestore();
  });

  it('given the page does not answer the init again, when 15 seconds pass, then the run ends as page gone', async () => {
    const { opened, resume } = await restarted(never);
    opened.mute();
    const resumed = await resumeWallet(resume, soon());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const run = resumed!.run(sign).catch((err: unknown) => err);
    await vi.waitFor(() => expect(opened.inits()).toBe(2));
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await run).toBeInstanceOf(PageGone);
    expect(opened.ids).toHaveLength(1);
  });

  it('given the page reloaded with a new key, when the server rejoins, then the run ends as page gone at once and nothing is asked again', async () => {
    const { wallet, opened, resume } = await restarted(never);
    const resumed = await resumeWallet(resume, soon());
    opened.close();
    const reloaded = await replayingPage(wallet.url, async () => '0xother');
    const started = Date.now();

    await expect(resumed!.run(sign)).rejects.toBeInstanceOf(PageGone);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reloaded.ids).toEqual([]);
  });

  it('given the page reloads with a new key while a resumed ask waits on the owner, then the run ends as page gone', async () => {
    const { wallet, opened, resume } = await restarted(never);
    const resumed = await resumeWallet(resume, soon());

    const run = resumed!.run(async (ask) => {
      const asked = sign(ask);
      await vi.waitFor(() => expect(opened.ids).toHaveLength(2));
      opened.close();
      await replayingPage(wallet.url, async () => '0xother');
      return asked;
    });

    await expect(run).rejects.toBeInstanceOf(PageGone);
  });

  it('given a resumed ask that is not the request first sent under its id, then the caller gets the page refusal code -32600', async () => {
    const { resume } = await restarted(never);
    const resumed = await resumeWallet(resume, soon());

    await expect(resumed!.run((ask) => ask('personal_sign', ['0x69', '0xaa']))).rejects.toMatchObject({
      code: -32600,
    });
  });

  it('given a stored key that does not parse, when the server rejoins, then it is refused and leaves no socket on the relay', async () => {
    const corrupt = { ...(await restarted(never)).resume, key: 'zz' };
    await vi.waitFor(() => expect(sessions.get(corrupt.session)?.cli).toBeUndefined());

    await expect(resumeWallet(corrupt, soon())).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    expect(sessions.get(corrupt.session)?.cli).toBeUndefined();
  });

  it('given saving the session fails, then the run still asks the owner and answers', async () => {
    const wallet = await openRelay(84532);
    const opened = await replayingPage(wallet.url, async () => '0xsig');

    const answer = await wallet.run(sign, () => {
      throw new Error('database down');
    });

    expect(answer).toBe('0xsig');
    expect(opened.asked()).toBe(1);
  });

  it('given the owner pool is full, then a rejoin is busy', async () => {
    const { resume } = await restarted(never);
    vi.resetModules();
    const fresh = await import('./relay');
    for (let i = 0; i < fresh.SESSION_LIMITS.owner; i++) await fresh.ownerRelay(84532, soon());

    await expect(fresh.resumeWallet(resume, soon())).rejects.toBeInstanceOf(fresh.WalletBusy);
  });
});
