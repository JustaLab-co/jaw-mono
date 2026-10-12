import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { sanitizeLine, usdcForNetwork } from '@jaw.id/agent';
import { eq } from 'drizzle-orm';
import { isAddress, isAddressEqual, isHex, stringToHex, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { getDb } from '@/db/client';
import { connections } from '@/db/schema';
import { budgetGrant, checkGranted, readOnChain, recordGrant, type ReadPermission } from '@/grants/permission';
import { verifyOnChain, type VerifySignature } from '@/lib/chain';
import { errorLabel, ipKey, log } from '@/lib/edge';
import { bridge } from './bridge';
import { config } from './config';
import { provider } from './provider';
import { connectRelay, type Ask, type OpenWallet } from './relay';
import { activate, armTicket, CONNECTION_TTL_MS, findClaimable, pendingFor } from './rows';
import { CONNECTION_SCOPES, FIRST_PARTY_CLIENTS, spends, type ConnectionScope } from './scopes';
import { seal } from './seal';

const UID = /^[A-Za-z0-9_-]{10,64}$/;
// Zero-width and other invisible characters, which would let a name read as another.
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** Left to the page to complete the authorization once the wallet answers, before the interaction ends. */
const COMPLETE_WITHIN_MS = 60_000;

export interface InteractionDeps {
  openWallet: OpenWallet;
  verify: VerifySignature;
  readPermission: ReadPermission;
}

const DEFAULTS: InteractionDeps = { openWallet: connectRelay, verify: verifyOnChain, readPermission: readOnChain };

interface Asked {
  uid: string;
  clientId: string;
  clientName: string;
  /** The domain of a third-party client's metadata document: the part of its identity it cannot fake. */
  clientHost: string | undefined;
  scopes: ConnectionScope[];
  chainId: number;
  expiresAt: Date;
}

const hostOf = (clientId: string) => {
  try {
    return new URL(clientId).host;
  } catch {
    return undefined;
  }
};

async function loadInteraction(uid: string): Promise<Asked | undefined> {
  if (!UID.test(uid)) return undefined;
  const p = provider();
  const interaction = await p.Interaction.find(uid);
  if (!interaction || interaction.exp * 1000 <= Date.now()) return undefined;
  const params = interaction.params as Record<string, string | undefined>;
  const client = params.client_id ? await p.Client.find(params.client_id) : undefined;
  if (!client) return undefined;
  const asked = (params.scope ?? '').split(' ');
  const scopes = (Object.keys(CONNECTION_SCOPES) as ConnectionScope[]).filter((s) => asked.includes(s));
  // Every tool needs it; the provider refuses an authorization without it before this.
  if (!scopes.includes('wallet:read')) return undefined;
  const firstParty = Object.hasOwn(FIRST_PARTY_CLIENTS, client.clientId);
  const declared = (client.clientName ?? client.clientId).replace(HIDDEN, '');
  return {
    uid,
    clientId: client.clientId,
    clientName: firstParty ? FIRST_PARTY_CLIENTS[client.clientId] : sanitizeLine(declared, 64),
    clientHost: firstParty ? undefined : hostOf(client.clientId),
    scopes,
    chainId: config().chain.id,
    expiresAt: new Date(interaction.exp * 1000),
  };
}

// Derived from the interaction under the server's key, so every replica shows the
// same ones: a reload served elsewhere keeps the code the owner compares and the
// ticket the approval is stored under.
const derived = (purpose: string, uid: string) =>
  createHmac('sha256', config().ring.keys[0].seal).update(`${purpose}:${uid}`).digest();
const ticketOf = (uid: string) => derived('ticket', uid).toString('base64url');
/** Six characters the page and the wallet both show. No 0/O or 1/I, which read alike. */
export const codeOf = (uid: string) =>
  [...derived('code', uid).subarray(0, 6)].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

/**
 * What the owner signs before anything else. It names the app and what it asks
 * for, and the code its page shows: the wallet link can be forwarded, and only
 * the person looking at that page can tell it is the request they made.
 */
export const connectMessage = (a: Asked, account: Address) =>
  [
    `Connect ${a.clientName} to ${new URL(config().issuer).host}`,
    ...(a.clientHost ? [`App domain: ${a.clientHost}`] : []),
    `Allows: ${a.scopes.map((s) => CONNECTION_SCOPES[s]).join('; ')}`,
    `Code: ${codeOf(a.uid)}`,
    '',
    'Approve only if the page that sent you here shows this code.',
    '',
    `Account: ${account}`,
    `Chain: ${a.chainId}`,
    `Expires: ${a.expiresAt.toISOString()}`,
  ].join('\n');

/** The account that signed in on the message that names this request. */
async function signIn(a: Asked, ask: Ask, deps: InteractionDeps): Promise<Address> {
  const [account] = (await ask('eth_requestAccounts', [])) as unknown[];
  if (typeof account !== 'string' || !isAddress(account)) throw new Error('the wallet returned no account');
  const message = connectMessage(a, account);
  const signature = await ask('personal_sign', [stringToHex(message), account]);
  if (!isHex(signature)) throw new Error('the wallet returned no signature');
  const valid = await deps.verify({
    chainId: a.chainId,
    address: account,
    payload: { type: 'message', message },
    signature,
  });
  if (!valid) throw new Error('bad_signature');
  return account;
}

/** The budget the account granted the spender, as the chain confirms it. */
async function askBudget(a: Asked, ask: Ask, account: Address, spender: Address, deps: InteractionDeps) {
  const usdc = usdcForNetwork(`eip155:${a.chainId}`);
  if (!usdc) throw new Error('no USDC on this chain');
  const grant = budgetGrant({
    chainId: a.chainId,
    spender,
    token: usdc.address,
    allowance: config().dailyBudget,
    expiry: Math.floor((Date.now() + CONNECTION_TTL_MS) / 1000),
  });
  const answer = await ask('wallet_grantPermissions', [grant]);
  const checked = await checkGranted(a.chainId, grant, answer, deps.readPermission);
  if (typeof checked === 'string') throw new Error(checked);
  if (!isAddressEqual(checked.account as Address, account)) throw new Error('grant_mismatch');
  return checked;
}

// What the page may say about a failure: the refusals this module raises, never
// another error's message, which can quote a query and its parameters.
const SHOWN = new Set([
  'invalid_response',
  'grant_mismatch',
  'grant_not_found',
  'verification_unavailable',
  'bad_signature',
  'already_connected',
  'another_account_signed_in_first',
]);
export const reasonOf = (err: unknown) => {
  if ((err as { code?: unknown })?.code === 4001) return 'turned down in the wallet';
  if (!(err instanceof Error)) return 'the wallet did not approve';
  // Raised by the relay session itself, so the text is this server's own.
  if (err.message.startsWith('the wallet page refused:') || err.message === 'timed out waiting for the wallet') {
    return err.message;
  }
  return SHOWN.has(err.message) ? err.message : 'the wallet did not approve';
};

/** The owner's approval in flight on this replica, so a second click here hands out the same link. */
interface Job {
  walletUrl: string;
  failed?: string;
}
const jobs = new Map<string, Job>();

/**
 * Sessions one address, or one client, may hold open on this replica at once, so
 * a few callers starting authorizations cannot fill the pool every owner draws on.
 */
export const SESSIONS_PER_IP = 5;
export const SESSIONS_PER_CLIENT = 50;
const holding = new Map<string, number>();
const holds = (key: string) => holding.get(key) ?? 0;

function take(keys: string[]) {
  for (const key of keys) holding.set(key, holds(key) + 1);
  return () => {
    for (const key of keys) {
      if (holds(key) > 1) holding.set(key, holds(key) - 1);
      else holding.delete(key);
    }
  };
}

/** The pending connection of this interaction for `account`, with its session key stored. */
async function pending(a: Asked, account: Address) {
  const id = `conn_${randomBytes(16).toString('base64url')}`;
  const key = generatePrivateKey();
  const row = await pendingFor({
    id,
    account,
    sessionAddress: privateKeyToAddress(key),
    sealedKey: seal(config().ring, key, id),
    chainId: a.chainId,
    clientId: a.clientId,
    clientName: a.clientName,
    scopes: a.scopes,
    interactionUid: a.uid,
    expiresAt: a.expiresAt,
  });
  if (!row) throw new Error('another_account_signed_in_first');
  return { id: row.id, spender: row.sessionAddress as Address };
}

async function start(a: Asked, deps: InteractionDeps, keys: string[]): Promise<Job> {
  const wallet = await deps.openWallet(a.chainId, new Date(a.expiresAt.getTime() - COMPLETE_WITHIN_MS));
  const job: Job = { walletUrl: wallet.url };
  const release = take(keys);
  void wallet
    .run(async (ask) => {
      const account = await signIn(a, ask, deps);
      const { id, spender } = await pending(a, account);
      const grant = spends(a.scopes) ? await askBudget(a, ask, account, spender, deps) : undefined;
      await getDb().transaction(async (tx) => {
        if (grant) await recordGrant(tx, id, grant);
        if (!(await armTicket(a.uid, sha256(ticketOf(a.uid)), tx))) throw new Error('already_connected');
      });
    })
    .catch((err: unknown) => {
      job.failed = reasonOf(err);
      log('warn', { msg: 'connection not approved', error: errorLabel(err) });
    })
    .finally(release);
  return job;
}

export async function hop(_req: Request, uid: string): Promise<Response> {
  const asked = await loadInteraction(uid);
  if (!asked) return page(410, 'This request expired. Start again from your app.');
  return page(200, '', asked);
}

/**
 * Opens the wallet session when the owner clicks "Open JAW", from the browser that
 * started the authorization: it needs the interaction cookie, which a cross-site
 * request does not carry.
 */
export async function openSession(req: Request, uid: string, deps = DEFAULTS): Promise<Response> {
  const ip = await ipKey(req);
  const p = provider();
  return bridge(req, async (nodeReq, nodeRes) => {
    const interaction = await p.interactionDetails(nodeReq, nodeRes).catch(() => undefined);
    if (!interaction || interaction.uid !== uid) return fail(nodeRes, 400, 'interaction_mismatch');
    const asked = await loadInteraction(uid);
    if (!asked) return fail(nodeRes, 410, 'expired');
    let job = jobs.get(uid);
    if (!job || job.failed) {
      const client = `client:${asked.clientHost ?? asked.clientId}`;
      if (holds(client) >= SESSIONS_PER_CLIENT || (ip && holds(ip) >= SESSIONS_PER_IP)) {
        return fail(nodeRes, 429, 'too_many_open');
      }
      try {
        job = await start(asked, deps, ip ? [client, ip] : [client]);
      } catch (err) {
        log('error', { msg: 'wallet unreachable', error: errorLabel(err) });
        return fail(nodeRes, 503, 'wallet_unreachable');
      }
      jobs.set(uid, job);
      setTimeout(() => jobs.delete(uid), asked.expiresAt.getTime() - Date.now()).unref();
    }
    nodeRes.setHeader('content-type', 'application/json');
    nodeRes.setHeader('cache-control', 'no-store');
    nodeRes.end(JSON.stringify({ url: job.walletUrl }));
  });
}

/** Where the owner's approval stands. A failure is only known to the replica that ran it. */
export async function status(_req: Request, uid: string): Promise<Response> {
  if (!UID.test(uid)) return Response.json({ error: 'not_found' }, { status: 404 });
  const [row] = await getDb()
    .select({ status: connections.status, ticketHash: connections.ticketHash })
    .from(connections)
    .where(eq(connections.interactionUid, uid));
  // A pending row is approved once its ticket is armed; before that it only holds the key.
  if (row?.status === 'active' || (row?.status === 'pending' && row.ticketHash === sha256(ticketOf(uid)))) {
    return Response.json({ state: 'approved' });
  }
  const failed = jobs.get(uid)?.failed;
  return Response.json(failed ? { state: 'failed', reason: failed } : { state: 'waiting' });
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(status: number, error: string, asked?: Asked): Response {
  const body = asked ? connectBody(asked) : `<p>${escape(error)}</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to JAW</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}.code{font:700 1.6rem/1 ui-monospace,monospace;letter-spacing:.2em}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The uid and the ticket ride in this page's URLs; no other site needs them.
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    },
  });
}

function connectBody(a: Asked): string {
  const budget = Number(config().dailyBudget) / 1e6;
  const what = spends(a.scopes)
    ? `Your wallet will ask you to sign in, then to approve a budget of up to ${budget} USDC a day for it. Payments within it need nothing more from you.`
    : 'Your wallet will ask you to sign in.';
  // JSON in a script: "<" escaped so nothing in it can close the tag.
  const data = JSON.stringify({ uid: a.uid, ticket: ticketOf(a.uid) }).replace(/</g, '\\u003c');
  const from = a.clientHost
    ? `<p>From <strong>${escape(a.clientHost)}</strong>. That domain is checked; the name is the app's own.</p>`
    : '';
  return `<h1>Connect ${escape(a.clientName)}</h1>
${from}
<p>${escape(what)}</p>
<p>The sign-in shows this code. Approve only if it matches:</p>
<p class="code">${codeOf(a.uid)}</p>
<p><button id="open">Open JAW</button></p>
<p id="state">Waiting for your wallet.</p>
<p><a href="/interaction/${a.uid}/abort">Cancel</a></p>
<script>
const d = ${data};
const state = document.getElementById('state');
const refused = {
  429: 'Too many approvals are open from here or for this app. Finish or cancel one, then try again.',
  503: 'The wallet cannot be reached right now. Try again.',
};
// The popup opens on the click itself, which browsers allow, and gets the link once the session is up.
document.getElementById('open').onclick = async () => {
  const popup = window.open('', 'jaw', 'popup,width=440,height=760');
  const r = await fetch('/interaction/' + d.uid + '/open', { method: 'POST' }).catch(() => undefined);
  const url = r && r.ok ? (await r.json()).url : undefined;
  if (!url) {
    popup?.close();
    state.textContent = (r && refused[r.status]) || 'This request expired. Start again from your app.';
    return;
  }
  if (popup) return void (popup.location = url);
  const link = Object.assign(document.createElement('a'), { href: url, target: '_blank', textContent: 'Open the wallet' });
  state.replaceChildren(link);
};
const poll = async () => {
  const s = await fetch('/interaction/' + d.uid + '/status').then((r) => r.json()).catch(() => ({ state: 'waiting' }));
  if (s.state === 'approved') return location.assign('/interaction/' + d.uid + '/complete?ticket=' + d.ticket);
  if (s.state === 'failed') return (state.textContent = 'Not connected: ' + s.reason + '. Reload this page to try again.');
  setTimeout(poll, 2000);
};
poll();
</script>`;
}

function fail(res: ServerResponse, status: number, error: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error }));
}

// Completion needs both the ticket (this browser loaded the page the wallet link
// came from) and the interaction cookie (this browser started).
export function complete(req: Request, uid: string): Promise<Response> {
  const ticketHash = sha256(new URL(req.url).searchParams.get('ticket') ?? '');
  const p = provider();
  return bridge(req, async (nodeReq, nodeRes) => {
    const interaction = await p.interactionDetails(nodeReq, nodeRes).catch(() => undefined);
    if (!interaction || interaction.uid !== uid) return fail(nodeRes, 400, 'interaction_mismatch');
    const row = await findClaimable(uid, ticketHash);
    if (!row) return fail(nodeRes, 400, 'invalid_ticket');

    const grant = new p.Grant({ accountId: row.id, clientId: row.clientId });
    grant.addOIDCScope('openid offline_access');
    grant.addResourceScope(config().resource, row.scopes.join(' '));
    // Scopes not granted count as answered, or the provider would ask for consent again.
    const unticked = Object.keys(CONNECTION_SCOPES).filter((s) => !row.scopes.includes(s));
    if (unticked.length) grant.rejectResourceScope(config().resource, unticked.join(' '));
    const grantId = await grant.save();
    if (!(await activate(uid, ticketHash, grantId))) {
      await grant.destroy();
      return fail(nodeRes, 400, 'invalid_ticket');
    }
    try {
      await p.interactionFinished(
        nodeReq,
        nodeRes,
        { login: { accountId: row.id, remember: false }, consent: { grantId } },
        { mergeWithLastSubmission: false }
      );
    } catch {
      // No code reached the client, so the connection must not stay usable.
      // Destroying the grant revokes the connection with it.
      await grant.destroy();
      return fail(nodeRes, 500, 'hand_back_failed');
    }
  });
}

export function abort(req: Request, uid: string): Promise<Response> {
  const p = provider();
  return bridge(req, async (nodeReq, nodeRes) => {
    const interaction = await p.interactionDetails(nodeReq, nodeRes).catch(() => undefined);
    if (!interaction || interaction.uid !== uid) return fail(nodeRes, 400, 'interaction_mismatch');
    await p.interactionFinished(
      nodeReq,
      nodeRes,
      { error: 'access_denied', error_description: 'The user declined the connection' },
      { mergeWithLastSubmission: false }
    );
  });
}
