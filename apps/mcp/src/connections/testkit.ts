import { createHash, randomBytes } from 'node:crypto';
import { toFunctionSelector, verifyMessage, verifyTypedData, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { currentGrant, type Grant } from '@/grants/store';
import type { GrantRequest, ReadPermission } from '@/grants/permission';
import type { SignedPayload } from '@/lib/chain';
import { verifyBearer, type Tenant } from './auth';
import type { DisconnectDeps, Sent } from './disconnect';
import { abort, complete, hop, openSession, status, type InteractionDeps } from './interaction';
import { oauth } from './provider';
import type { Ask, OpenWallet } from './relay';

export const ISSUER = 'http://mcp.test';
export const RESOURCE = `${ISSUER}/mcp`;
export const REDIRECT = 'http://127.0.0.1:8765/callback';

export function setTestEnv(keys = randomBytes(32).toString('base64url')) {
  process.env.JAW_MCP_PUBLIC_URL = ISSUER;
  process.env.JAW_KEYS_URL = 'http://keys.test';
  process.env.JAW_MCP_SEALING_KEYS = keys;
}

export const owner = () => privateKeyToAccount(generatePrivateKey());

export const approvedOnChain: ReadPermission = async () => ({ status: 'ok', approved: true, revoked: false });

/** What the owner's wallet answers, signing with `signer`. `refuse` lists methods the owner turns down. */
export function walletAnswers(signer: ReturnType<typeof owner>, refuse: string[] = []): Ask {
  return async (method, params) => {
    if (refuse.includes(method)) throw Object.assign(new Error('User rejected the request'), { code: 4001 });
    switch (method) {
      case 'eth_requestAccounts':
        return [signer.address];
      case 'personal_sign':
        return signer.signMessage({ message: { raw: params[0] as Hex } });
      case 'wallet_grantPermissions': {
        const grant = params[0] as GrantRequest;
        return {
          permissionId: `0x${randomBytes(32).toString('hex')}`,
          account: signer.address,
          spender: grant.spender,
          start: 1_780_000_000,
          end: grant.expiry,
          salt: '0x2a',
          calls: grant.permissions.calls.map((c) => ({
            target: c.target,
            selector: toFunctionSelector(c.functionSignature),
          })),
          spends: grant.permissions.spends,
        };
      }
    }
    throw new Error(`the test wallet does not answer ${method}`);
  };
}

const runs = new Set<Promise<unknown>>();

/** A wallet that answers at once, as if the owner approved everything asked. */
export const fakeWallet =
  (answer: Ask, asked: { method: string; params: unknown[] }[] = []): OpenWallet =>
  async () => ({
    url: `http://keys.test/cli-bridge?session=${randomBytes(8).toString('hex')}`,
    run: (work) => {
      const done = work((method, params) => {
        asked.push({ method, params });
        return answer(method, params);
      });
      const settled: Promise<unknown> = done.catch(() => undefined).finally(() => runs.delete(settled));
      runs.add(settled);
      return done;
    },
  });

/** For a test that never sends as the session: any send, or chain read around one, fails. */
export const offlineSession: Pick<DisconnectDeps, 'clients' | 'sender'> = {
  clients: {
    publicClient: () => {
      throw new Error('this test reads no chain');
    },
  },
  sender: () => Promise.reject(new Error('this test sends nothing as the session')),
};

export const SENT_TX = `0x${'ab'.repeat(32)}` as Hex;
export type SessionCall = { to: Address; data: Hex };

/** A session account holding `float` USDC whose batches end as `outcome` says, with what it sent. */
export function sessionFakes(outcome: Sent = { status: 'landed', txHash: SENT_TX }, float = 500_000n) {
  const sent: SessionCall[][] = [];
  const node = { getBlockNumber: async () => 100n, readContract: async () => float } as unknown as PublicClient;
  const deps: Pick<DisconnectDeps, 'clients' | 'sender'> = {
    clients: { publicClient: () => node },
    sender: async () => ({
      paymaster: '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402',
      quote: async () => ({ expected: 2_000n, max: 10_000n }),
      send: async (calls) => {
        sent.push(calls);
        return outcome;
      },
    }),
  };
  return { deps, sent };
}

/** Waits for every wallet session the server started to finish, including ones started meanwhile. */
export const walletsSettled = async () => {
  while (runs.size) await Promise.all(runs);
  // Then what the server chained after each run, such as freeing its slot.
  await new Promise((resolve) => setImmediate(resolve));
};

let interactionDeps: InteractionDeps = {
  openWallet: fakeWallet(walletAnswers(owner())),
  verify: (a) => verifyLocally(a),
  readPermission: approvedOnChain,
};

/** The wallet the next authorization opens, and how it is checked. */
export function setWallet(deps: Partial<InteractionDeps>) {
  interactionDeps = { ...interactionDeps, ...deps };
}

export class Browser {
  private cookies = new Map<string, { value: string; path: string }>();
  /** The wallet this browser's owner approves in; the one set with setWallet when absent. */
  wallet?: InteractionDeps;

  async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(new URL(url), { headers });
  }

  async post(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(new URL(url), { method: 'POST', headers });
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    const cookie = [...this.cookies]
      .filter(([, c]) => url.pathname.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await route(new Request(url, { ...init, headers }), this.wallet ?? interactionDeps);
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const [name, value] = pair.split('=');
      const path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      this.cookies.set(name, { value, path });
    }
    // An auto-submitting form, as the provider renders for a logout confirmation.
    const html = res.headers.get('content-type')?.includes('text/html') ? await res.clone().text() : '';
    const action = html.match(/<form method="post" action="([^"]+)"/)?.[1];
    if (!action) return res;
    const fields = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)];
    return this.send(new URL(action.replaceAll('&amp;', '&'), url), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields.map(([, k, v]) => [k, v])).toString(),
    });
  }
}

async function route(req: Request, deps: InteractionDeps): Promise<Response> {
  const [, first, uid, action] = new URL(req.url).pathname.split('/');
  if (first !== 'interaction') return oauth(req);
  if (action === undefined) return hop(req, uid);
  if (action === 'open') return openSession(req, uid, deps);
  const handler = { status, complete, abort }[action];
  if (!handler) throw new Error(`no route for ${req.url}`);
  return handler(req, uid);
}

export interface Authorize {
  clientId?: string;
  redirectUri?: string;
  /** null sends no scope parameter at all. */
  scope?: string | null;
  resource?: string;
  pkce?: boolean;
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** An authorization through to its page, where the owner clicks "Open JAW" unless `click` is false. */
export async function startAuthorization(
  browser: Browser,
  a: Authorize = {},
  { headers = {}, click = true }: { headers?: Record<string, string>; click?: boolean } = {}
) {
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({
    client_id: a.clientId ?? 'jaw-cli',
    redirect_uri: a.redirectUri ?? REDIRECT,
    response_type: 'code',
    ...(a.scope === null ? {} : { scope: a.scope ?? 'wallet:read x402:pay wallet:send' }),
    state: 'st',
    resource: a.resource ?? RESOURCE,
    ...(a.pkce === false ? {} : { code_challenge: challenge, code_challenge_method: 'S256' }),
  });
  let url = `${ISSUER}/oauth/authorize?${params}`;
  for (let hop = 0; hop < 5; hop++) {
    const res = await browser.get(url);
    const location = res.headers.get('location');
    if (!location) return { verifier, stopped: res };
    url = new URL(location, url).href;
    const uid = url.match(/\/interaction\/([^/?]+)$/)?.[1];
    if (uid) {
      const html = await (await browser.get(url)).text();
      const opened = click ? await browser.post(`${url}/open`, headers) : undefined;
      return { verifier, uid, ticket: html.match(/"ticket":"([^"]+)"/)?.[1], html, opened };
    }
    if (url.startsWith(a.redirectUri ?? REDIRECT)) return { verifier, redirected: new URL(url) };
  }
  throw new Error('too many redirects');
}

export const verifyLocally = ({
  address,
  payload,
  signature,
}: {
  address: Address;
  payload: SignedPayload;
  signature: Hex;
}) =>
  (payload.type === 'message'
    ? verifyMessage({ address, message: payload.message, signature })
    : verifyTypedData({ address, signature, ...payload.typedData })
  ).catch(() => false);

export interface TokenBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function token(body: Record<string, string>) {
  const res = await oauth(
    new Request(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    })
  );
  return { status: res.status, body: (await res.json()) as TokenBody };
}

export async function follow(browser: Browser, url: string, redirectUri = REDIRECT): Promise<URL> {
  for (let hop = 0; hop < 5; hop++) {
    const location = (await browser.get(url)).headers.get('location');
    if (!location) throw new Error(`no redirect from ${new URL(url).pathname}`);
    url = new URL(location, url).href;
    if (url.startsWith(redirectUri)) return new URL(url);
  }
  throw new Error('too many redirects');
}

/** An authorization the owner approves in their wallet, through to the tokens. */
export async function connect(
  signer = owner(),
  a: Authorize = {},
  browser = new Browser(),
  read: ReadPermission = approvedOnChain
) {
  browser.wallet = { ...interactionDeps, openWallet: fakeWallet(walletAnswers(signer)), readPermission: read };
  const start = await startAuthorization(browser, a);
  if (!start.uid || !start.ticket) throw new Error('authorization did not reach the wallet');
  await walletsSettled();
  const redirected = await follow(
    browser,
    `${ISSUER}/interaction/${start.uid}/complete?ticket=${start.ticket}`,
    a.redirectUri ?? REDIRECT
  );
  const issued = await token({
    grant_type: 'authorization_code',
    code: redirected.searchParams.get('code')!,
    redirect_uri: a.redirectUri ?? REDIRECT,
    client_id: a.clientId ?? 'jaw-cli',
    code_verifier: start.verifier,
    resource: RESOURCE,
  });
  return { signer, uid: start.uid, ...issued.body, status: issued.status };
}

type Route = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function mcp(token: string | undefined, body: object, route?: Route) {
  const POST: Route = route ?? (await import('@/app/mcp/route')).POST;
  const res = await POST(
    new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    }),
    { params: Promise.resolve({}) }
  );
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return { status: res.status, headers: res.headers, text, json: data ? JSON.parse(data.slice(6)) : undefined };
}

export const callTool = async (token: string, name: string, args: object) =>
  (await mcp(token, { method: 'tools/call', params: { name, arguments: args } })).json?.result;

/** A connection whose owner approved the default daily budget when connecting, the chain read faked by `read`. */
export async function budgetConnection(read: ReadPermission = approvedOnChain) {
  const c = await connect(owner(), {}, new Browser(), read);
  const tenant = (await verifyBearer(c.access_token))?.extra?.tenant as Tenant;
  const grant = (await currentGrant(tenant.connectionId)) as Grant;
  return {
    c,
    tenant,
    sessionAddress: tenant.sessionAddress,
    permissionId: grant.permissionId,
    permission: grant.permission,
  };
}
