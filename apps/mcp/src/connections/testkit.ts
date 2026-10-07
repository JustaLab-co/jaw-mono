import { createHash, randomBytes } from 'node:crypto';
import { verifyMessage, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { abort, complete, consent, details, hop, type ConsentDetails } from './interaction';
import { oauth } from './provider';

// Drives the OAuth flow through the route handlers the way a browser and a
// loopback client would. Test-only.

export const ISSUER = 'http://mcp.test';
export const RESOURCE = `${ISSUER}/mcp`;
export const REDIRECT = 'http://127.0.0.1:8765/callback';

export function setTestEnv(keys = randomBytes(32).toString('base64url')) {
  process.env.JAW_MCP_PUBLIC_URL = ISSUER;
  process.env.JAW_KEYS_URL = 'http://keys.test';
  process.env.JAW_MCP_SEALING_KEYS = keys;
}

/** Cookie jar that honours each cookie's path, as a browser does. */
export class Browser {
  private cookies = new Map<string, { value: string; path: string }>();

  async get(url: string): Promise<Response> {
    const { pathname } = new URL(url);
    const cookie = [...this.cookies]
      .filter(([, c]) => pathname.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
    const res = await route(new Request(url, { headers: cookie ? { cookie } : {} }));
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const [name, value] = pair.split('=');
      const path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      this.cookies.set(name, { value, path });
    }
    return res;
  }
}

/** Dispatches like the Next app router does for these paths. */
async function route(req: Request): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/');
  if (parts[1] !== 'interaction') return oauth(req);
  const handler = { undefined: hop, details, complete, abort }[String(parts[3])];
  if (!handler) throw new Error(`no route for ${req.url}`);
  return handler(req);
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

/** Starts an authorization in `browser` and follows redirects until keys.jaw.id or the client. */
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
  return (await details(new Request(`${ISSUER}/interaction/${uid}/details`))).json();
}

export async function postConsent(uid: string, address: Hex, signature: Hex) {
  return consent(
    new Request(`${ISSUER}/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, signature }),
    }),
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

/** Follows redirects in `browser` until one lands on the client's redirect URI. */
export async function follow(browser: Browser, url: string, redirectUri = REDIRECT): Promise<URL> {
  for (let hop = 0; hop < 5; hop++) {
    const location = (await browser.get(url)).headers.get('location');
    if (!location) throw new Error(`no redirect from ${new URL(url).pathname}`);
    url = new URL(location, url).href;
    if (url.startsWith(redirectUri)) return new URL(url);
  }
  throw new Error('too many redirects');
}

/** The whole happy path: authorize, consent as `signer`, complete, exchange the code. */
export async function connect(signer = owner(), a: Authorize = {}) {
  const browser = new Browser();
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
