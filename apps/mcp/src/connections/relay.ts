import { createHash, randomUUID } from 'node:crypto';
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
// Next compiles instrumentation apart from the routes, so each gets its own copy of this module.
const POOLS = Symbol.for('jaw-mcp/relay-pools');
const pools = ((globalThis as { [POOLS]?: { connect: Pool; owner: Pool } })[POOLS] ??= {
  connect: { limit: SESSION_LIMITS.connect, open: 0, byAccount: new Map(), joinWithin: JOIN_WITHIN_MS },
  owner: { limit: SESSION_LIMITS.owner, open: 0, perAccount: SESSION_LIMITS.ownerPerAccount, byAccount: new Map() },
});
const connectPool = pools.connect;
const ownerPool = pools.owner;

export const connectRelay: OpenWallet = (chainId, until, client) =>
  withSlot(connectPool, client, (release) =>
    startSession(release, chainId, until, client, { onNewPage: 'ignore', joinWithin: connectPool.joinWithin })
  );
export const ownerRelay: OpenWallet = (chainId, until, client) =>
  withSlot(ownerPool, client, (release) => startSession(release, chainId, until, client, { onNewPage: 'takeOver' }));

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
  client: RelayClient | undefined,
  { onNewPage, joinWithin }: { onNewPage: NewPage; joinWithin?: number }
): Promise<Wallet> {
  const keys = await generateKeyPair();
  const session = randomUUID();
  const { ws, inbox, end } = connect(session, until, release, joinWithin);

  return {
    url: linkOf(session, await exportKeyToHex('public', keys.publicKey)),
    run: async (work, joined) => {
      try {
        const hello = await inbox.next((m) => m.type === 'key_exchange' && typeof m.publicKey === 'string');
        const init = { chainId, appName: appNameOf(client) };
        const page = converse(ws, inbox, session, {
          key: keys.privateKey,
          init,
          onNewPage,
          // Runs again for each page the owner opens the link in, so a rejoin after a restart finds the one open.
          joined: async (peer) => {
            // A session that cannot be resumed is how every session ran before replays, so the owner is still asked.
            try {
              const saved = joined?.({ session, key: await exportKeyToHex('private', keys.privateKey), peer, ...init });
              await within(JOINED_WITHIN_MS, Promise.resolve(saved));
            } catch (err) {
              log('warn', { msg: 'relay session not saved', error: errorLabel(err) });
            }
          },
        });
        await page.meet(String(hello.publicKey));
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
  return { ws, inbox, end };
}

/**
 * The name new accounts get a subname under, read at each init rather than kept
 * in the saved session, so a rejoin sends what the server is configured with now.
 */
function ensOf(): { ens?: string } {
  const { ens } = config();
  return ens ? { ens } : {};
}

function linkOf(session: string, publicKey: string): string {
  const { keysOrigin, relayUrl } = config();
  const url = new URL('/cli-bridge', keysOrigin);
  url.searchParams.set('session', session);
  url.searchParams.set('relay', relayUrl);
  url.hash = `pk=${publicKey}`;
  return url.toString();
}

type Key = Awaited<ReturnType<typeof importKeyFromHex>>;

/**
 * What a page that keys in with a new key does to the session.
 *
 * - `takeOver`: an owner's request link. The owner closes the tab and clicks the link in the chat again, and the
 *   new page carries on with the request.
 * - `ignore`: the connect link. It lives in the owner's own browser, its page opens a new session per click, and a
 *   later page there would be someone else signing in.
 * - `gone`: a rejoin, which holds to the page it saved. A new key means that page is gone, and what happened on it
 *   while this server was away cannot be told.
 */
type NewPage = 'takeOver' | 'ignore' | 'gone';

interface Talk {
  /** This server's private key, the same for every page that opens the session. */
  key: Key;
  /** What each page is started with. */
  init: { chainId: number; appName: string };
  onNewPage: NewPage;
  /** Called with the key of each page that says it can replay answers, once that page has the session. */
  joined?: (peer: string) => Promise<void>;
}

/** A page behind the link, by the key it sent and the secret agreed with it. */
interface Page {
  peer: string;
  secret: Key;
}

/** A page that keyed in and was sent init, but does not have the session yet. */
interface Candidate extends Page {
  /** Whether it came after the run's first key, so its taking the session is a takeover. */
  reopened: boolean;
  /** Unset until its ready is read, then whether it said it can replay answers. */
  replays?: boolean;
  /** How many of the run's identity requests it has answered with the accounts first answered. */
  checked: number;
}

// The requests that tell which account the owner is signed in with. A page that takes over is asked them again.
const IDENTITY = new Set(['eth_requestAccounts', 'wallet_connect']);
// How a page sends its public key. The CLI's bridge takes nothing else either.
const HEX_KEY = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * The accounts in an answer to an identity request, lowercased: the list of
 * addresses eth_requestAccounts answers, or the `{ accounts }` of
 * wallet_connect, whose entries are addresses or `{ address }`.
 */
function accountsOf(data: unknown): string[] {
  const list = Array.isArray(data) ? data : (data as { accounts?: unknown } | null | undefined)?.accounts;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const address = typeof entry === 'string' ? entry : (entry as { address?: unknown } | null | undefined)?.address;
    return typeof address === 'string' ? [address.toLowerCase()] : [];
  });
}

const sameAccounts = (a: string[], b: string[]) => a.length === b.length && a.every((account, i) => account === b[i]);

function refusalOf(answer: Message): WalletRefused {
  const error = answer.error as { code?: number; message?: string } | undefined;
  return new WalletRefused(error?.message ?? 'the wallet refused', error?.code);
}

const refusedToStart = (inner: Message) =>
  ending('WalletPageRefused', `the wallet page refused: ${String(inner.reason)}`);

/** What the logs carry for a relay session: a short hash, so lines of one link match without the id that joins it. */
export const relaySessionTag = (session: string) => createHash('sha256').update(session).digest('hex').slice(0, 12);

/**
 * The exchange with the page behind a link, encrypted under a key agreed with
 * that page.
 *
 * The page makes a new key each time it loads, and the relay cuts off the page
 * it had as soon as another joins. A page that keys in is first a candidate: it
 * is sent init under its own key, and the page in use keeps the session until
 * the candidate's ready is read under that key, which shows it holds the link.
 * A candidate that never says it is ready changes nothing. What a key after the
 * first does is set by the link, in `onNewPage`.
 *
 * On an owner's request link a newer key takes the candidate's place, and a
 * candidate also has to show the owner's account before it takes over. The
 * flows check the account once, on the first page, and the request still
 * waiting would reach the new page without that check. So the candidate is
 * asked each identity request of this run again under its id, and takes over
 * only if it answers with the accounts first answered. The waiting request is
 * then sent to it again under the same id. Another account ends the run.
 */
function converse(ws: WebSocket, inbox: Inbox, session: string, { key, init, onNewPage, joined }: Talk) {
  const relaySession = relaySessionTag(session);
  // The page that has the session, once one is ready.
  let page: Page | undefined;
  let candidate: Candidate | undefined;
  // Each identity request this run got an answer to, with the accounts in that first answer.
  const identities: { request: Message; accounts: string[] }[] = [];
  // The inbox has one reader, so a run waits on one ask at a time. This is that ask, which a page that takes over is sent again.
  let pending: Message | undefined;
  // The later pages a connect link ignored, so each is logged once.
  const ignored = new Set<string>();

  const sendWith = async (secret: Key, payload: Message) =>
    ws.send(JSON.stringify({ type: 'encrypted', ...(await encryptMessage(secret, payload)) }));
  const send = (payload: Message) => sendWith(page!.secret, payload);
  const open = (secret: Key, m: Message) =>
    decryptMessage(secret, m as unknown as EncryptedEnvelope).catch(() => undefined);
  const agree = (publicKey: string) =>
    importKeyFromHex('public', publicKey)
      .then((peer) => deriveSharedSecret(key, peer))
      .catch(() => undefined);

  /** Makes the page that sent `publicKey` the candidate and starts it. */
  const consider = async (publicKey: unknown, reopened: boolean) => {
    // The key comes in plaintext from whoever knows the session id, so one no secret can be agreed with is dropped.
    const secret = typeof publicKey === 'string' && HEX_KEY.test(publicKey) ? await agree(publicKey) : undefined;
    if (typeof publicKey !== 'string' || !secret) {
      log('warn', { msg: 'relay key dropped', relaySession });
      return;
    }
    if (reopened) log('info', { msg: 'relay page reopened', relaySession });
    candidate = { peer: publicKey, secret, reopened, checked: 0 };
    await sendWith(secret, { type: 'init', ...init, ...ensOf() });
  };

  /** What a key does, by the link's policy, when it is neither the page's nor the candidate's. */
  const keyed = async (publicKey: unknown) => {
    if (typeof publicKey === 'string' && (publicKey === page?.peer || publicKey === candidate?.peer)) return;
    if (onNewPage === 'gone') throw new PageGone();
    if (onNewPage === 'ignore' && (page || candidate)) {
      const later = String(publicKey);
      if (!ignored.has(later)) log('info', { msg: 'relay later page ignored', relaySession });
      ignored.add(later);
      return;
    }
    // A key after one that was dropped is still the run's first page, not a reopen.
    await consider(publicKey, Boolean(page || candidate));
  };

  /** Gives the session to a candidate that showed it holds the link, and the owner's account where asked. */
  const commit = async (c: Candidate) => {
    page = { peer: c.peer, secret: c.secret };
    candidate = undefined;
    if (c.reopened) log('info', { msg: 'relay page took over', relaySession });
    // Saved before the request goes out again, so a restart in between still finds this page.
    if (c.replays) await joined?.(c.peer);
    if (pending) await send(pending);
  };

  /** Asks a ready candidate the next identity request it has not answered, or commits it once none is left. */
  const proceed = async (c: Candidate) => {
    const next = identities[c.checked];
    if (next) await sendWith(c.secret, next.request);
    else await commit(c);
  };

  /** What a candidate said: its ready, then its answers to the identity requests asked again. */
  const heard = async (c: Candidate, inner: Message) => {
    if (inner.type === 'error') throw refusedToStart(inner);
    if (c.replays === undefined) {
      if (inner.type !== 'ready') return;
      c.replays = inner.replays === true;
      return proceed(c);
    }
    const check = identities[c.checked];
    if (!check || inner.type !== 'rpc_response' || inner.id !== check.request.id) return;
    // The owner turned down the account on the page they now have open, and the page they left is cut off.
    if (!inner.success) throw refusalOf(inner);
    if (!sameAccounts(accountsOf(inner.data), check.accounts)) {
      log('warn', { msg: 'relay page signed in with another account', relaySession });
      throw new PageAccountChanged();
    }
    c.checked++;
    return proceed(c);
  };

  /**
   * Reads the next frame. Keys and what a candidate says are handled here, and
   * what the page in use says is returned. A frame is tried under the
   * candidate's secret first, so a page still starting is heard while the one
   * in use keeps the session.
   */
  const step = async (by?: Date): Promise<Message | undefined> => {
    const wanted = (m: Message) => m.type === 'encrypted' || m.type === 'key_exchange';
    const m = by ? await inbox.within(wanted, by) : await inbox.next(wanted);
    if (!m) throw new PageGone();
    if (m.type === 'key_exchange') {
      await keyed(m.publicKey);
      return undefined;
    }
    const starting = candidate;
    const early = starting && (await open(starting.secret, m));
    if (starting && early) {
      await heard(starting, early);
      return undefined;
    }
    const inner = page && (await open(page.secret, m));
    if (inner?.type === 'error') throw refusedToStart(inner);
    return inner;
  };

  const read = async (want: (inner: Message) => boolean) => {
    for (;;) {
      const inner = await step();
      if (inner && want(inner)) return inner;
    }
  };

  /** Starts the page that sent `publicKey`, and reads until a page has the session: that one, or one opened after it. */
  const meet = async (publicKey: string, by?: Date) => {
    await consider(publicKey, false);
    while (!page) await step(by);
  };

  let asked = 0;
  const ask: Ask = async (method, params) => {
    const request = { type: 'rpc_request', id: `${session}:${asked++}`, method, params };
    pending = request;
    const answer = await send(request)
      .then(() => read((m) => m.type === 'rpc_response' && m.id === request.id))
      .finally(() => (pending = undefined));
    if (answer.success) {
      if (IDENTITY.has(method)) identities.push({ request, accounts: accountsOf(answer.data) });
      return answer.data;
    }
    const code = (answer.error as { code?: unknown } | undefined)?.code;
    // A rejoined page refuses an id it answered for another request: what happened there cannot be told.
    if (onNewPage === 'gone' && code === NOT_THE_REQUEST) throw new PageGone();
    throw refusalOf(answer);
  };
  return { send, meet, ask };
}

const REJOIN_WITHIN_MS = 15_000;
const NOT_THE_REQUEST = -32600;
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
  constructor(message = 'the wallet page is gone') {
    super(message);
  }
}

/**
 * The page the owner opened the link in again signed in with another account
 * than the one this run first heard. It is a page gone, so the request ends the
 * way it does when its page is lost, and nothing waiting is sent to that page.
 */
export class PageAccountChanged extends PageGone {
  override name = 'PageAccountChanged';
  constructor() {
    super('the wallet page signed in with another account');
  }
}

/** Rejoins the session behind `url`, the link the owner already has open. Undefined means the page is gone. */
export const resumeWallet = (
  resume: RelayResume,
  url: string,
  until: Date,
  client?: RelayClient
): Promise<Wallet | undefined> => withSlot(ownerPool, client, (release) => rejoin(release, resume, url, until));

async function rejoin(release: () => void, resume: RelayResume, url: string, until: Date): Promise<Wallet | undefined> {
  const { session, key, peer, chainId, appName } = resume;
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
        const page = converse(ws, inbox, session, {
          key: await importKeyFromHex('private', key),
          init: { chainId, appName },
          onNewPage: 'gone',
        });
        await page.meet(peer, soon());
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
    ws.addEventListener('error', () => this.close(ending('RelayFailed', 'the relay connection failed')));
    ws.addEventListener('close', () => this.close(ending('RelayClosed', 'the wallet session ended')));
  }

  /** Ends every wait with `err`, unless the session already ended with another. */
  close(err: Error) {
    this.closed ??= err;
    this.waiter?.();
  }

  async next(want: (m: Message) => boolean): Promise<Message> {
    const m = await this.within(want, this.until);
    if (!m) throw ending('WalletTimedOut', 'timed out waiting for the wallet');
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
