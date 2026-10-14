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
import { afterAll, describe, expect, it } from 'vitest';
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
