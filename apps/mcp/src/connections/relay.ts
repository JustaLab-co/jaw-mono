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

/** A request to the owner's wallet, answered with what the wallet returns or thrown with why it refused. */
export type Ask = (method: string, params: unknown[]) => Promise<unknown>;

/** A wallet session the owner opens at `url`. `run` asks it things, then closes it. */
export interface Wallet {
  url: string;
  run<T>(work: (ask: Ask) => Promise<T>): Promise<T>;
}

/** Opens a session that ends at `until`, answered or not. */
export type OpenWallet = (chainId: number, until: Date) => Promise<Wallet>;

/**
 * Sessions one process holds open at once, each a socket waiting on an owner.
 * Authorizations and the owner's tool requests have pools of their own, so a
 * flood of authorizations cannot take the slots budget and revoke requests need.
 */
export const SESSION_LIMITS = { connect: 150, owner: 50 };

export class WalletBusy extends Error {
  constructor() {
    super('too many wallet sessions are open on this server');
  }
}

type Message = Record<string, unknown>;

interface Pool {
  limit: number;
  open: number;
}
const connectPool: Pool = { limit: SESSION_LIMITS.connect, open: 0 };
const ownerPool: Pool = { limit: SESSION_LIMITS.owner, open: 0 };

export const connectRelay: OpenWallet = (chainId, until) => openRelay(connectPool, chainId, until);
export const ownerRelay: OpenWallet = (chainId, until) => openRelay(ownerPool, chainId, until);

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
async function openRelay(pool: Pool, chainId: number, until: Date): Promise<Wallet> {
  if (pool.open >= pool.limit) throw new WalletBusy();
  const { keysOrigin, relayUrl } = config();
  const keys = await generateKeyPair();
  const session = randomUUID();
  const url = new URL('/cli-bridge', keysOrigin);
  url.searchParams.set('session', session);
  url.searchParams.set('relay', relayUrl);
  url.hash = `pk=${await exportKeyToHex('public', keys.publicKey)}`;

  pool.open++;
  const ws = new WebSocket(`${relayUrl}?session=${encodeURIComponent(session)}&role=cli`);
  ws.addEventListener('close', () => pool.open--, { once: true });
  // Ends the session at its deadline even if nobody runs it.
  setTimeout(() => ws.close(), until.getTime() - Date.now()).unref();
  const inbox = new Inbox(ws, until);

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
            if (inner?.type === 'error') throw new Error(`the wallet page refused: ${String(inner.reason)}`);
            if (inner && want(inner)) return inner;
          }
        };

        await send({ type: 'init', chainId });
        await read((m) => m.type === 'ready');

        const ask: Ask = async (method, params) => {
          const id = randomUUID();
          await send({ type: 'rpc_request', id, method, params });
          const answer = await read((m) => m.type === 'rpc_response' && m.id === id);
          if (answer.success) return answer.data;
          const error = answer.error as { code?: number; message?: string } | undefined;
          throw Object.assign(new Error(error?.message ?? 'the wallet refused'), { code: error?.code });
        };
        const result = await work(ask);
        // Closes the wallet tab.
        await send({ type: 'shutdown' }).catch(() => undefined);
        return result;
      } finally {
        ws.close();
      }
    },
  };
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

  private close(err: Error) {
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
      if (left <= 0) throw new Error('timed out waiting for the wallet');
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
