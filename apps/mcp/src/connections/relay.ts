import { randomUUID } from 'node:crypto';
import {
  decryptMessage,
  deriveSharedSecret,
  encryptMessage,
  exportKeyToHex,
  generateKeyPair,
  importKeyFromHex,
  type EncryptedEnvelope,
} from '@jaw.id/agent';
import { config } from './config';
import { FIRST_PARTY_CLIENTS } from './scopes';

/** A request to the owner's wallet, answered with what the wallet returns or thrown with why it refused. */
export type Ask = (method: string, params: unknown[]) => Promise<unknown>;

/** A wallet session the owner opens at `url`. `run` asks it things, then closes it. */
export interface Wallet {
  url: string;
  run<T>(work: (ask: Ask) => Promise<T>): Promise<T>;
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

/** Named, because the log keeps only an error's name: the name says how the session ended. */
const ending = (name: string, message: string) => Object.assign(new Error(message), { name });

/** The wallet answered a request with an error, with or without a code. */
export class WalletRefused extends Error {
  override name = 'WalletRefused';
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

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

export const connectRelay: OpenWallet = (chainId, until, client) => openRelay(connectPool, chainId, until, client);
export const ownerRelay: OpenWallet = (chainId, until, client) => openRelay(ownerPool, chainId, until, client);

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
async function openRelay(pool: Pool, chainId: number, until: Date, client?: RelayClient): Promise<Wallet> {
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
    return await startSession(release, chainId, until, client, pool.joinWithin);
  } catch (err) {
    release();
    throw err;
  }
}

async function startSession(
  release: () => void,
  chainId: number,
  until: Date,
  client?: RelayClient,
  joinWithin?: number
): Promise<Wallet> {
  const { keysOrigin, relayUrl } = config();
  const keys = await generateKeyPair();
  const session = randomUUID();
  const url = new URL('/cli-bridge', keysOrigin);
  url.searchParams.set('session', session);
  url.searchParams.set('relay', relayUrl);
  url.hash = `pk=${await exportKeyToHex('public', keys.publicKey)}`;

  const ws = new WebSocket(`${relayUrl}?session=${encodeURIComponent(session)}&role=cli`);
  const inbox = new Inbox(ws, until);
  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, KEEPALIVE_MS);
  keepalive.unref();
  // Ends the session at its deadline even if nobody runs it.
  const deadline = setTimeout(() => {
    inbox.close(ending('WalletTimedOut', 'timed out waiting for the wallet'));
    end();
  }, until.getTime() - Date.now());
  deadline.unref();
  const unjoined =
    joinWithin === undefined
      ? undefined
      : setTimeout(() => {
          inbox.close(ending('WalletLinkUnopened', 'the wallet link was not opened in time'));
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
    inbox.close(ending('WalletSessionClosed', 'the wallet session ended'));
    ws.close();
    stop();
  };
  ws.addEventListener('close', stop, { once: true });
  ws.addEventListener('message', (e) => {
    if (typeOf(e.data) === 'browser_connected') clearTimeout(unjoined);
  });

  return {
    url: url.toString(),
    run: async (work) => {
      try {
        const peer = await inbox.next((m) => m.type === 'key_exchange' && typeof m.publicKey === 'string');
        const secret = await deriveSharedSecret(
          keys.privateKey,
          await importKeyFromHex('public', String(peer.publicKey))
        );
        const send = async (payload: Message) =>
          ws.send(JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) }));
        const read = async (want: (inner: Message) => boolean) => {
          for (;;) {
            const m = await inbox.next((m) => m.type === 'encrypted');
            const inner = await decryptMessage(secret, m as unknown as EncryptedEnvelope).catch(() => undefined);
            if (inner?.type === 'error') {
              throw ending('WalletPageRefused', `the wallet page refused: ${String(inner.reason)}`);
            }
            if (inner && want(inner)) return inner;
          }
        };

        await send({ type: 'init', chainId, appName: appNameOf(client) });
        await read((m) => m.type === 'ready');

        const ask: Ask = async (method, params) => {
          const id = randomUUID();
          await send({ type: 'rpc_request', id, method, params });
          const answer = await read((m) => m.type === 'rpc_response' && m.id === id);
          if (answer.success) return answer.data;
          const error = answer.error as { code?: number; message?: string } | undefined;
          throw new WalletRefused(error?.message ?? 'the wallet refused', error?.code);
        };
        const result = await work(ask);
        // Closes the wallet tab.
        await send({ type: 'shutdown' }).catch(() => undefined);
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
    ws.addEventListener('error', () => this.close(ending('RelayFailed', 'the relay connection failed')));
    ws.addEventListener('close', () => this.close(ending('RelayClosed', 'the wallet session ended')));
  }

  /** Ends every wait with `err`, unless the session already ended with another. */
  close(err: Error) {
    this.closed ??= err;
    this.waiter?.();
  }

  async next(want: (m: Message) => boolean): Promise<Message> {
    for (;;) {
      const at = this.queue.findIndex(want);
      if (at !== -1) return this.queue.splice(0, at + 1)[at];
      this.queue = [];
      if (this.closed) throw this.closed;
      const left = this.until.getTime() - Date.now();
      if (left <= 0) throw ending('WalletTimedOut', 'timed out waiting for the wallet');
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
