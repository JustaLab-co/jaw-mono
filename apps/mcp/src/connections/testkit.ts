import { createHash, randomBytes } from 'node:crypto';
import { verifyMessage, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { abort, complete, consent, details, hop, type ConsentDetails } from './interaction';
import { oauth } from './provider';

export const ISSUER = 'http://mcp.test';
export const RESOURCE = `${ISSUER}/mcp`;
export const REDIRECT = 'http://127.0.0.1:8765/callback';

export function setTestEnv(keys = randomBytes(32).toString('base64url')) {
  process.env.JAW_MCP_PUBLIC_URL = ISSUER;
  process.env.JAW_KEYS_URL = 'http://keys.test';
  process.env.JAW_MCP_SEALING_KEYS = keys;
}

export class Browser {
  private cookies = new Map<string, { value: string; path: string }>();

  async get(url: string): Promise<Response> {
    return this.send(new URL(url), {});
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    const cookie = [...this.cookies]
      .filter(([, c]) => url.pathname.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await route(new Request(url, { ...init, headers }));
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

async function route(req: Request): Promise<Response> {
  const [, first, uid, action] = new URL(req.url).pathname.split('/');
  if (first !== 'interaction') return oauth(req);
  if (action === undefined) return hop(req, uid);
  const handler = { details, complete, abort }[action];
  if (!handler) throw new Error(`no route for ${req.url}`);
  return handler(req, uid);
}

export interface Authorize {
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  resource?: string;
  pkce?: boolean;
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function startAuthorization(browser: Browser, a: Authorize = {}) {
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({
    client_id: a.clientId ?? 'jaw-cli',
    redirect_uri: a.redirectUri ?? REDIRECT,
    response_type: 'code',
    scope: a.scope ?? 'wallet:read',
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
    if (url.startsWith('http://keys.test/')) return { verifier, uid: new URL(url).searchParams.get('uid')! };
    if (url.startsWith(a.redirectUri ?? REDIRECT)) return { verifier, redirected: new URL(url) };
  }
  throw new Error('too many redirects');
}

export const owner = () => privateKeyToAccount(generatePrivateKey());
export const verifyLocally = ({ address, message, signature }: { address: Hex; message: string; signature: Hex }) =>
  verifyMessage({ address, message, signature });

export async function getDetails(uid: string): Promise<ConsentDetails> {
  return (await details(new Request(`${ISSUER}/interaction/${uid}/details`), uid)).json();
}

export async function postConsent(uid: string, address: Hex, signature: Hex) {
  return consent(
    new Request(`${ISSUER}/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, signature }),
    }),
    uid,
    verifyLocally
  );
}

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

export async function connect(signer = owner(), a: Authorize = {}, browser = new Browser()) {
  const start = await startAuthorization(browser, a);
  if (!start.uid) throw new Error('authorization did not reach consent');
  const d = await getDetails(start.uid);
  const res = await postConsent(start.uid, signer.address, await signer.signMessage({ message: d.message }));
  const { next } = (await res.json()) as { next: string };
  const redirected = await follow(browser, next, a.redirectUri ?? REDIRECT);
  const issued = await token({
    grant_type: 'authorization_code',
    code: redirected.searchParams.get('code')!,
    redirect_uri: a.redirectUri ?? REDIRECT,
    client_id: a.clientId ?? 'jaw-cli',
    code_verifier: start.verifier,
    resource: RESOURCE,
  });
  return { signer, details: d, uid: start.uid, ...issued.body, status: issued.status };
}

export async function mcp(token: string | undefined, body: object) {
  const { POST } = await import('@/app/mcp/route');
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
