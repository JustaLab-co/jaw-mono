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
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { setTestEnv } from './testkit';

// A relay that pairs the two roles of a session and forwards what each sends, as relay.jaw.id does.
const seen: string[] = [];
const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
const sessions = new Map<string, { cli?: WebSocket; browser?: WebSocket }>();
relay.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'ws://relay');
  const id = url.searchParams.get('session')!;
  const role = url.searchParams.get('role') as 'cli' | 'browser';
  const pair = sessions.get(id) ?? {};
  pair[role] = ws;
  sessions.set(id, pair);
  if (role === 'browser') pair.cli?.send(JSON.stringify({ type: 'browser_connected' }));
  ws.on('message', (data) => {
    seen.push(String(data));
    (role === 'cli' ? pair.browser : pair.cli)?.send(String(data));
  });
});
await new Promise((r) => relay.once('listening', r));

setTestEnv();
process.env.JAW_RELAY_URL = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
process.env.JAW_MCP_API_KEY = 'server-secret-key';
const { appNameOf, connectRelay, ownerRelay, SESSION_LIMITS, WalletBusy } = await import('./relay');
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
  const shutdown = new Promise<void>((resolve) => {
    ws.on('message', async (data) => {
      const inner = await decryptMessage(secret, JSON.parse(String(data)) as EncryptedEnvelope);
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
  return { inits, shutdown };
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

    expect((await relay.connectRelay(84532, until, as(ACCOUNT))).url).toMatch(/cli-bridge/);
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

  it('given the account is full, then jaw_request_budget answers busy instead of throwing', async () => {
    const relay = await fresh();
    const { requestBudget } = await import('../tools/request-budget');
    const until = new Date(Date.now() + 8_000);
    await fill(relay, ACCOUNT, until);
    const t = { ...as(ACCOUNT), connectionId: 'conn', chainId: 84532, sessionAddress: OTHER, scopes: [] };

    const result = await requestBudget(t as never, '1', {
      openWallet: relay.ownerRelay,
      readPermission: async () => null as never,
      clients: undefined as never,
      sender: undefined as never,
    });

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
