import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  exportKeyToHex,
  generateKeyPair,
  importKeyFromHex,
  type EncryptedEnvelope,
} from '@jaw.id/agent';
import { errorLabel, log } from '@/lib/edge';
import { config } from './config';
import { FIRST_PARTY_CLIENTS } from './scopes';
import type { RelayResume } from './seal';

/** A request to the owner's wallet, answered with what the wallet returns or thrown with why it refused. */
export type Ask = (method: string, params: unknown[]) => Promise<unknown>;

/** A wallet session the owner opens at `url`. `run` asks it things, then closes it. */
export interface Wallet {
  url: string;
  run<T>(work: (ask: Ask) => Promise<T>, joined?: (resume: RelayResume) => unknown): Promise<T>;
  close(): void;
}

/** The OAuth client a session is opened for, named on the wallet page. */
export interface RelayClient {
  clientId: string;
  clientName: string;
  /** The owner account the session is for. Counts against that account's share of the pool. */
  account?: string;
}

/** Opens a session that ends at `until`, answered or not. */
export type OpenWallet = (chainId: number, until: Date, client?: RelayClient) => Promise<Wallet>;

const APP_NAME_MAX = 64;
const SELF_ASSERTED = ' (via JAW MCP)';
// Keep in sync with resolveBridgeAppName in apps/keys-jaw-id/src/lib/bridge-app-name.ts.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * What the wallet page calls the app. Any client can claim a name or a public
 * client id, so the name always carries the route it came by.
 */
export function appNameOf(client?: RelayClient): string {
  const known = client && Object.hasOwn(FIRST_PARTY_CLIENTS, client.clientId);
  const raw = known ? FIRST_PARTY_CLIENTS[client.clientId] : (client?.clientName ?? '');
  const claimed = Array.from(raw.replace(/\s+/g, ' ').replace(UNSEEN, '').replace(/\s+/g, ' ').trim());
  const name = claimed
    .slice(0, APP_NAME_MAX - SELF_ASSERTED.length)
    .join('')
    .trim();
  return name ? name + SELF_ASSERTED : 'JAW MCP';
}

/**
 * Sessions one process holds open at once, each a socket waiting on an owner.
 * Authorizations and the owner's tool requests have pools of their own, so a
 * flood of authorizations cannot take the slots budget and revoke requests need.
 * Authorizations are not counted per account, as nobody is known yet when they open.
 * The count is per process; the database cap covers the replicas.
 */
export const SESSION_LIMITS = { connect: 150, owner: 50, ownerPerAccount: 5 };

// relay.jaw.id ends a session after 15 minutes with no message from either side.
const KEEPALIVE_MS = 5 * 60_000;
// An authorization link nobody opened gives its slot back; another click on the page opens a new one.
const JOIN_WITHIN_MS = 10 * 60_000;

export class WalletBusy extends Error {
  constructor() {
    super('too many wallet sessions are open on this server');
  }
}

type Message = Record<string, unknown>;

interface Pool {
  limit: number;
  open: number;
  perAccount?: number;
  byAccount: Map<string, number>;
  /** How long a session waits for the browser to join before it ends. */
  joinWithin?: number;
}
const connectPool: Pool = {
  limit: SESSION_LIMITS.connect,
  open: 0,
  byAccount: new Map(),
  joinWithin: JOIN_WITHIN_MS,
};
const ownerPool: Pool = {
  limit: SESSION_LIMITS.owner,
  open: 0,
  perAccount: SESSION_LIMITS.ownerPerAccount,
  byAccount: new Map(),
};

export const connectRelay: OpenWallet = (chainId, until, client) =>
  withSlot(connectPool, client, (release) => startSession(release, chainId, until, client, connectPool.joinWithin));
export const ownerRelay: OpenWallet = (chainId, until, client) =>
  withSlot(ownerPool, client, (release) => startSession(release, chainId, until, client));

async function withSlot<T>(pool: Pool, client: RelayClient | undefined, start: (release: () => void) => Promise<T>) {
  const account = pool.perAccount ? client?.account?.toLowerCase() : undefined;
  const mine = account ? (pool.byAccount.get(account) ?? 0) : 0;
  if (pool.open >= pool.limit || mine >= (pool.perAccount ?? Infinity)) throw new WalletBusy();
  // Taken before the first await, so sessions asked for together cannot all pass the check.
  pool.open++;
  if (account) pool.byAccount.set(account, mine + 1);
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    pool.open--;
    if (!account) return;
    const left = (pool.byAccount.get(account) ?? 1) - 1;
    if (left > 0) pool.byAccount.set(account, left);
    else pool.byAccount.delete(account);
  };
  try {
    return await start(release);
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * A session on JAW's relay, the channel `jaw session setup` uses. The owner opens
 * keys.jaw.id/cli-bridge, and every request runs through the wallet's own
 * dialogs. Messages are encrypted end to end under a key agreed through the
 * public key in the link's fragment, which never reaches the relay.
 *
 * Nothing in it carries this server's key: whoever holds the link can read the
 * session, and the page takes the key of its own deployment.
 *
 * The socket is opened here, before the link is handed out, so the relay knows
 * this side is waiting when the page connects.
 */
async function startSession(
  release: () => void,
  chainId: number,
  until: Date,
  client?: RelayClient,
  joinWithin?: number
): Promise<Wallet> {
  const keys = await generateKeyPair();
  const session = randomUUID();
  const { ws, inbox, end } = connect(session, until, release, joinWithin);

  return {
    url: linkOf(session, await exportKeyToHex('public', keys.publicKey)),
    run: async (work, joined) => {
      try {
        const hello = await inbox.next((m) => m.type === 'key_exchange' && typeof m.publicKey === 'string');
        const peer = String(hello.publicKey);
        const secret = await deriveSharedSecret(keys.privateKey, await importKeyFromHex('public', peer));
        const page = converse(ws, inbox, secret, session);
        const init = { chainId, appName: appNameOf(client) };
        await page.send({ type: 'init', ...init });
        const ready = await page.read((m) => m.type === 'ready');
        if (ready.replays === true) {
          // A session that cannot be resumed is how every session ran before replays, so the owner is still asked.
          try {
            const saved = joined?.({ session, key: await exportKeyToHex('private', keys.privateKey), peer, ...init });
            await within(JOINED_WITHIN_MS, Promise.resolve(saved));
          } catch (err) {
            log('warn', { msg: 'relay session not saved', error: errorLabel(err) });
          }
        }
        const result = await work(page.ask);
        // Closes the wallet tab.
        await page.send({ type: 'shutdown' }).catch(() => undefined);
        return result;
      } finally {
        end();
      }
    },
    close: end,
  };
}

function connect(session: string, until: Date, release: () => void, joinWithin?: number) {
  const ws = new WebSocket(`${config().relayUrl}?session=${encodeURIComponent(session)}&role=cli`);
  const inbox = new Inbox(ws, until);
  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, KEEPALIVE_MS);
  keepalive.unref();
  // Ends the session at its deadline even if nobody runs it.
  const deadline = setTimeout(() => end(), until.getTime() - Date.now());
  deadline.unref();
  const unjoined =
    joinWithin === undefined
      ? undefined
      : setTimeout(() => {
          inbox.close(new Error('the wallet link was not opened in time'));
          end();
        }, joinWithin);
  unjoined?.unref();
  const stop = () => {
    clearInterval(keepalive);
    clearTimeout(deadline);
    clearTimeout(unjoined);
    release();
  };
  // A socket closed while still connecting never fires `close`, so closing frees the slot itself.
  const end = () => {
    ws.close();
    stop();
  };
  ws.addEventListener('close', stop, { once: true });
  ws.addEventListener('message', (e) => {
    if (typeOf(e.data) === 'browser_connected') clearTimeout(unjoined);
  });
  return { ws, inbox, end };
}

function linkOf(session: string, publicKey: string): string {
  const { keysOrigin, relayUrl } = config();
  const url = new URL('/cli-bridge', keysOrigin);
  url.searchParams.set('session', session);
  url.searchParams.set('relay', relayUrl);
  url.hash = `pk=${publicKey}`;
  return url.toString();
}

function converse(
  ws: WebSocket,
  inbox: Inbox,
  secret: Awaited<ReturnType<typeof deriveSharedSecret>>,
  session: string,
  peer?: string
) {
  const send = async (payload: Message) =>
    ws.send(JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) }));
  const read = async (want: (inner: Message) => boolean, by?: Date) => {
    const wanted = (m: Message) => m.type === 'encrypted' || (peer !== undefined && m.type === 'key_exchange');
    for (;;) {
      const m = by ? await inbox.within(wanted, by) : await inbox.next(wanted);
      if (!m) throw new PageGone();
      if (m.type === 'key_exchange') {
        if (m.publicKey !== peer) throw new PageGone();
        continue;
      }
      const inner = await decryptMessage(secret, m as unknown as EncryptedEnvelope).catch(() => undefined);
      if (inner?.type === 'error') throw new Error(`the wallet page refused: ${String(inner.reason)}`);
      if (inner && want(inner)) return inner;
    }
  };
  let asked = 0;
  const ask: Ask = async (method, params) => {
    const id = `${session}:${asked++}`;
    await send({ type: 'rpc_request', id, method, params });
    const answer = await read((m) => m.type === 'rpc_response' && m.id === id);
    if (answer.success) return answer.data;
    const error = answer.error as { code?: number; message?: string } | undefined;
    throw Object.assign(new Error(error?.message ?? 'the wallet refused'), { code: error?.code });
  };
  return { send, read, ask };
}

const REJOIN_WITHIN_MS = 15_000;
// Saving the session must not hold the first ask back.
const JOINED_WITHIN_MS = 5_000;

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class PageGone extends Error {
  constructor() {
    super('the wallet page is gone');
  }
}

/** Rejoins a session the server held before it restarted. Undefined means the page is gone. */
export const resumeWallet = (resume: RelayResume, until: Date, client?: RelayClient): Promise<Wallet | undefined> =>
  withSlot(ownerPool, client, (release) => rejoin(release, resume, until));

async function rejoin(release: () => void, resume: RelayResume, until: Date): Promise<Wallet | undefined> {
  const { session, key, peer, chainId, appName } = resume;
  const ours = createPrivateKey({ key: Buffer.from(key, 'hex'), format: 'der', type: 'pkcs8' });
  const url = linkOf(session, createPublicKey(ours).export({ format: 'der', type: 'spki' }).toString('hex'));
  const { ws, inbox, end } = connect(session, until, release);
  const soon = () => new Date(Math.min(until.getTime(), Date.now() + REJOIN_WITHIN_MS));
  const status = await inbox
    .within((m) => m.type === 'status', soon())
    .catch((err: unknown) => {
      end();
      throw err;
    });
  if (status?.browserConnected !== true) {
    end();
    return undefined;
  }

  return {
    url,
    run: async (work) => {
      try {
        const secret = await deriveSharedSecret(
          await importKeyFromHex('private', key),
          await importKeyFromHex('public', peer)
        );
        const page = converse(ws, inbox, secret, session, peer);
        await page.send({ type: 'init', chainId, appName });
        await page.read((m) => m.type === 'ready', soon());
        const result = await work(page.ask);
        await page.send({ type: 'shutdown' }).catch(() => undefined);
        return result;
      } finally {
        end();
      }
    },
    close: end,
  };
}

function typeOf(data: unknown): unknown {
  try {
    return (JSON.parse(String(data)) as Message).type;
  } catch {
    return undefined;
  }
}

/** Messages from the relay, read in order by whoever is waiting for the next one that matters. */
class Inbox {
  private queue: Message[] = [];
  private waiter: (() => void) | undefined;
  private closed: Error | undefined;

  constructor(
    ws: WebSocket,
    private readonly until: Date
  ) {
    ws.addEventListener('message', (e) => {
      try {
        this.queue.push(JSON.parse(String(e.data)) as Message);
      } catch {
        return;
      }
      this.waiter?.();
    });
    ws.addEventListener('error', () => this.close(new Error('the relay connection failed')));
    ws.addEventListener('close', () => this.close(new Error('the wallet session ended')));
  }

  /** Ends every wait with `err`, unless the session already ended with another. */
  close(err: Error) {
    this.closed ??= err;
    this.waiter?.();
  }

  async next(want: (m: Message) => boolean): Promise<Message> {
    const m = await this.within(want, this.until);
    if (!m) throw new Error('timed out waiting for the wallet');
    return m;
  }

  async within(want: (m: Message) => boolean, by: Date): Promise<Message | undefined> {
    for (;;) {
      const at = this.queue.findIndex(want);
      if (at !== -1) return this.queue.splice(0, at + 1)[at];
      this.queue = [];
      if (this.closed) throw this.closed;
      const left = Math.min(by.getTime(), this.until.getTime()) - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = undefined;
    }
  }
}
