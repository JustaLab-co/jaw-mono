// An MCP client of the stack, over HTTP through the proxy: the OAuth flow with a
// consent signed by a throwaway EOA, refreshes, and tool calls.
import { createHash, randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PUBLIC_URL } from './stack.mjs';

const REDIRECT = 'http://127.0.0.1:8765/callback';
const RESOURCE = `${PUBLIC_URL}/mcp`;

/** One request through the proxy; `replica` pins it, otherwise round robin. */
export async function send(path, { replica, headers = {}, ...init } = {}) {
  const res = await fetch(new URL(path, PUBLIC_URL), {
    redirect: 'manual',
    ...init,
    headers: { ...headers, ...(replica ? { 'x-chaos-replica': replica } : {}) },
  });
  return res;
}

class Browser {
  cookies = new Map();

  async get(url, replica) {
    const u = new URL(url, PUBLIC_URL);
    const cookie = [...this.cookies]
      .filter(([, c]) => u.pathname.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
    const res = await send(u.pathname + u.search, { replica, headers: cookie ? { cookie } : {} });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const [name, value] = pair.split('=');
      const path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      this.cookies.set(name, { value, path });
    }
    return res;
  }
}

/**
 * Runs authorize, consent and the code exchange. `pin` names the replica for
 * each step: authorize, consent, complete (which issues the code) and token.
 * With `stopBeforeToken` it returns the code instead of exchanging it.
 */
export async function connect({ scope = 'wallet:read x402:pay wallet:send', pin = {}, stopBeforeToken = false } = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const browser = new Browser();
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: 'jaw-cli',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope,
    state: 'st',
    resource: RESOURCE,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  let res = await browser.get(`/oauth/authorize?${params}`, pin.authorize);
  const uid = res.headers.get('location')?.match(/\/interaction\/([^/?]+)/)?.[1];
  if (!uid) throw new Error(`authorize did not reach the interaction: ${res.status} ${await res.text()}`);

  const details = await (await send(`/interaction/${uid}/details`, { replica: pin.consent })).json();
  const signature = await owner.signTypedData(details.typedData);
  res = await send(`/interaction/${uid}/consent`, {
    replica: pin.consent,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: owner.address, signature }),
  });
  if (res.status !== 200) throw new Error(`consent refused: ${res.status} ${await res.text()}`);
  let url = (await res.json()).next;
  let code;
  for (let hop = 0; hop < 6 && !code; hop++) {
    res = await browser.get(url, pin.complete);
    const location = res.headers.get('location');
    if (!location)
      throw new Error(`no redirect from ${new URL(url, PUBLIC_URL).pathname}: ${res.status} ${await res.text()}`);
    url = new URL(location, PUBLIC_URL).href;
    if (url.startsWith(REDIRECT)) code = new URL(url).searchParams.get('code');
  }
  if (!code) throw new Error('no code reached the redirect');
  const exchange = (replica) =>
    token(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: 'jaw-cli',
        code_verifier: verifier,
        resource: RESOURCE,
      },
      replica
    );
  if (stopBeforeToken) return { owner, code, exchange };
  const issued = await exchange(pin.token);
  if (issued.status !== 200) throw new Error(`code exchange failed: ${issued.why}`);
  return { owner, ...issued.body };
}

export async function token(body, replica) {
  const res = await send('/oauth/token', {
    replica,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  // Only the error fields: a failure message must never carry a token.
  const why = `${res.status} ${json.error ?? ''} ${json.error_description ?? ''}`.trim();
  return { status: res.status, upstream: res.headers.get('x-chaos-upstream'), body: json, why };
}

export const refresh = (refreshToken, replica) =>
  token(
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'jaw-cli', resource: RESOURCE },
    replica
  );

export async function revoke(refreshToken, replica) {
  const res = await send('/oauth/revoke', {
    replica,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: 'jaw-cli' }),
  });
  return { status: res.status, upstream: res.headers.get('x-chaos-upstream') };
}

/** A tools/call. `result` is the JSON-RPC result, undefined when the call did not reach the tool. */
export async function tool(accessToken, name, args = {}, replica) {
  const res = await send('/mcp', {
    replica,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  const json = data ? JSON.parse(data.slice(6)) : undefined;
  return { status: res.status, upstream: res.headers.get('x-chaos-upstream'), text, result: json?.result };
}

export async function metrics(secret, replica) {
  const res = await send('/api/metrics', { replica, headers: { authorization: `Bearer ${secret}` } });
  const text = await res.text();
  const values = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+(?:\{[^}]*\})?) (\d+)$/);
    if (m) values[m[1]] = Number(m[2]);
  }
  return { status: res.status, values };
}

export async function cron(secret, replica) {
  const res = await send('/api/cron/reconcile', {
    replica,
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  });
  return {
    status: res.status,
    upstream: res.headers.get('x-chaos-upstream'),
    body: await res.json().catch(() => ({})),
  };
}
