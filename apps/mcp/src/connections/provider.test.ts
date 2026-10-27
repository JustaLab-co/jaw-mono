import { createHash, randomBytes } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { compactDecrypt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PGlite } from '@electric-sql/pglite';
import type { Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '@/db/test-db';
import {
  Browser,
  connect,
  follow,
  ISSUER,
  REDIRECT,
  RESOURCE,
  setTestEnv,
  setWallet,
  startAuthorization,
  token,
  verifyLocally,
  walletsSettled,
} from './testkit';

vi.mock('node:dns', async (original) => {
  const dns = await original<typeof import('node:dns')>();
  const lookup = ((host: string, opts: object, cb: (...a: unknown[]) => void) =>
    host.endsWith('.example.test') || host === 'chatgpt.com' || host === 'accountlinking.google.com'
      ? cb(null, [{ address: '93.184.216.34', family: 4 }])
      : dns.lookup(host, opts, cb)) as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});

setTestEnv();
const { verifyBearer } = await import('./auth');
const { config } = await import('./config');
const { createProvider } = await import('./provider');
const { PgAdapter } = await import('./adapter');
const { safeFetch } = await import('@/lib/safe-fetch');
const { findActive, revokeByGrant } = await import('./rows');
const { nextRefreshId, open, parseKeyRing, unwrap } = await import('./seal');
type KeyRing = ReturnType<typeof parseKeyRing>;

const CIMD = 'https://client.example.test/agent.json';
const IMPOSTOR = 'https://evil.example.test/jaw.json';
const HIDDEN_IMPOSTOR = 'https://evil.example.test/hidden.json';
const NAMED = 'https://named.example.test/';
const named = (name: string) => `${NAMED}${encodeURIComponent(name)}.json`;
const NUL_NAMED = 'https://evil.example.test/nul.json';
// A document with loopback redirects that name no port, and no application_type.
const LOOPBACK = 'https://claude.example.test/oauth/client-metadata';
const NO_REFRESH = 'https://norefresh.example.test/agent.json';
const SCOPED = 'https://scoped.example.test/';
const scoped = (scope: string) => `${SCOPED}${encodeURIComponent(scope)}.json`;
const KEYED = 'https://evil.example.test/keyed.json';
const PUBLIC_KEYED = 'https://evil.example.test/public-keyed.json';
// ChatGPT's published document, which authenticates at the token endpoint with private_key_jwt.
const CHATGPT = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_JWKS = 'https://chatgpt.com/oauth/jwks.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const chatgpt = {
  client_id: CHATGPT,
  client_uri: 'https://chatgpt.com/',
  redirect_uris: [CHATGPT_REDIRECT],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'ChatGPT',
  token_endpoint_auth_signing_alg: 'RS256',
  jwks_uri: CHATGPT_JWKS,
  logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
};
const CHATGPT_KEYS_ELSEWHERE = 'https://evil.example.test/chatgpt-keys.json';
const CHATGPT_INLINE_KEYS = 'https://chatgpt.com/oauth/inline-keys.json';
const CHATGPT_PUBLIC_KEYED = 'https://chatgpt.com/oauth/public-keyed.json';
const CHATGPT_NO_REFRESH = 'https://chatgpt.com/oauth/no-refresh.json';
const chatgptKey = await generateKeyPair('RS256');
const chatgptJwk = { ...(await exportJWK(chatgptKey.publicKey)), kid: 'cimd', alg: 'RS256', use: 'sig' };
const chatgptDocuments: Record<string, object> = {
  [CHATGPT]: chatgpt,
  [CHATGPT_JWKS]: { keys: [chatgptJwk] },
  [CHATGPT_KEYS_ELSEWHERE]: { ...chatgpt, client_id: CHATGPT_KEYS_ELSEWHERE },
  [CHATGPT_INLINE_KEYS]: {
    ...chatgpt,
    client_id: CHATGPT_INLINE_KEYS,
    jwks_uri: undefined,
    jwks: { keys: [chatgptJwk] },
  },
  [CHATGPT_PUBLIC_KEYED]: {
    ...chatgpt,
    client_id: CHATGPT_PUBLIC_KEYED,
    token_endpoint_auth_method: 'none',
    token_endpoint_auth_signing_alg: undefined,
  },
  [CHATGPT_NO_REFRESH]: { ...chatgpt, client_id: CHATGPT_NO_REFRESH, grant_types: ['authorization_code'] },
};
const assertionFor = async (clientId: string, key: CryptoKey) => ({
  client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
  client_assertion: await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'cimd' })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(ISSUER)
    .setJti(randomBytes(16).toString('hex'))
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(key),
});
const chatgptAssertion = (key = chatgptKey.privateKey) => assertionFor(CHATGPT, key);
// Gemini's document as Google serves it, which names Google's keys on another host.
const GEMINI =
  'https://accountlinking.google.com/clientidmetadata/user_bound_provider/user_bound_custom-mcp-1-mcp_jaw_id';
const GEMINI_JWKS =
  'https://www.gstatic.com/account-linking/.well-known/client-assertion-signature-verification-key.json';
const GEMINI_REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1-mcp_jaw_id';
const gemini = {
  client_id: GEMINI,
  client_name: 'Google',
  redirect_uris: [GEMINI_REDIRECT],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_signing_alg: 'RS256',
  jwks_uri: GEMINI_JWKS,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'wallet:read x402:pay',
};
const geminiKey = await generateKeyPair('RS256');
// A signing client whose keys sit on a local port the server must never reach.
const localSockets: Socket[] = [];
const localKeys = createServer((socket) => void localSockets.push(socket));
await new Promise<void>((resolve) => localKeys.listen(0, '127.0.0.1', resolve));
const LOCAL_JWKS = `https://127.0.0.1:${(localKeys.address() as AddressInfo).port}/jwks.json`;
const LOCAL_KEYED = 'https://evil.example.test/local-keys.json';
const keyedDocuments: Record<string, object> = {
  ...chatgptDocuments,
  [GEMINI]: gemini,
  [LOCAL_KEYED]: { ...gemini, client_id: LOCAL_KEYED, jwks_uri: LOCAL_JWKS },
  [GEMINI_JWKS]: { keys: [{ ...(await exportJWK(geminiKey.publicKey)), kid: 'cimd', alg: 'RS256', use: 'sig' }] },
};
const metadata = {
  client_id: CIMD,
  client_name: 'Example Agent',
  application_type: 'native',
  redirect_uris: ['http://127.0.0.1:9100/cb'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

let db: PGlite;

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  localSockets.forEach((socket) => socket.destroy());
  await new Promise((resolve) => localKeys.close(resolve));
});

beforeAll(async () => {
  db = await useTestDb();
  (globalThis as { jawMcpProvider?: unknown }).jawMcpProvider = createProvider(config(), {
    fetch: async (url: string | URL | Request) =>
      String(url) === CIMD
        ? Response.json(metadata, { headers: { 'cache-control': 'max-age=60' } })
        : String(url) === IMPOSTOR
          ? Response.json({ ...metadata, client_id: IMPOSTOR, client_name: 'JAW CLI' })
          : String(url) === HIDDEN_IMPOSTOR
            ? Response.json({ ...metadata, client_id: HIDDEN_IMPOSTOR, client_name: 'J\u200BA\u200BW Wallet' })
            : String(url) === NO_REFRESH
              ? Response.json({
                  ...metadata,
                  client_id: NO_REFRESH,
                  grant_types: ['authorization_code'],
                })
              : String(url) === KEYED
                ? Response.json({
                    ...metadata,
                    client_id: KEYED,
                    token_endpoint_auth_method: 'private_key_jwt',
                    jwks_uri: 'https://evil.example.test/jwks.json',
                  })
                : String(url) === PUBLIC_KEYED
                  ? Response.json({
                      ...metadata,
                      client_id: PUBLIC_KEYED,
                      jwks_uri: 'https://evil.example.test/jwks.json',
                    })
                  : String(url) === LOOPBACK
                    ? Response.json({
                        client_id: LOOPBACK,
                        client_name: 'Loopback Agent',
                        redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
                        grant_types: ['authorization_code', 'refresh_token'],
                        response_types: ['code'],
                        token_endpoint_auth_method: 'none',
                      })
                    : String(url) === NUL_NAMED
                      ? Response.json({ ...metadata, client_id: NUL_NAMED, client_name: 'Agent\u0000' })
                      : String(url).startsWith(NAMED)
                        ? Response.json({
                            ...metadata,
                            client_id: String(url),
                            client_name: decodeURIComponent(String(url).slice(NAMED.length, -'.json'.length)),
                          })
                        : Object.hasOwn(keyedDocuments, String(url))
                          ? Response.json(keyedDocuments[String(url)])
                          : String(url).startsWith(SCOPED)
                            ? Response.json({
                                ...metadata,
                                client_id: String(url),
                                scope: decodeURIComponent(String(url).slice(SCOPED.length, -'.json'.length)),
                              })
                            : String(url) === LOCAL_JWKS
                              ? safeFetch(new Set())(url)
                              : new Response('not found', { status: 404 }),
  });
});

const claimsOf = async (jwe: string, ring = config().ring) =>
  JSON.parse(new TextDecoder().decode((await compactDecrypt(jwe, ring.keys[0].jwe)).plaintext));

const refresh = (refreshToken: string) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'jaw-cli' });

const sessionAddressOf = async (accessToken: string, ring = config().ring) => {
  const { sub, sk } = await claimsOf(accessToken, ring);
  return privateKeyToAddress(open(ring, sk, sub));
};

async function withRing<T>(ring: KeyRing, run: () => Promise<T>): Promise<T> {
  const cache = globalThis as { jawMcpProvider?: unknown };
  const before = cache.jawMcpProvider;
  cache.jawMcpProvider = createProvider({ ...config(), ring });
  try {
    return await run();
  } finally {
    cache.jawMcpProvider = before;
  }
}

async function liveRefreshTokens(connectionId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from oauth_payloads p join connections c on p.grant_id = c.grant_id
     where c.id = $1 and p.model = 'RefreshToken' and p.consumed_at is null`,
    [connectionId]
  );
  return rows[0].n;
}

async function dumpStrings(): Promise<string[]> {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') found.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const table of ['settings', 'rate_limits', 'oauth_payloads', 'connections', 'grants', 'payments']) {
    walk((await db.query(`select * from ${table}`)).rows);
  }
  return [...found];
}

/** The session keys of one connection that the ring opens from a dump, alone or with the given tokens. */
function recoverable(dump: string[], ring: KeyRing, connectionId: string, tokens: string[]): string[] {
  const keys = new Set<string>();
  const attempt = (open: () => Hex) => {
    try {
      keys.add(privateKeyToAddress(open()));
    } catch {
      // not a blob these secrets open
    }
  };
  for (const blob of dump.filter((s) => /^\w+\.[0-9a-f]{16}\./.test(s))) {
    attempt(() => open(ring, blob as never, connectionId));
    for (const candidate of [...dump, ...tokens]) attempt(() => unwrap(ring, blob as never, connectionId, candidate));
  }
  return [...keys];
}

async function usedToken(connectionId: string) {
  const { rows } = await db.query<{ consumed_at: Date; key_wrap: unknown }>(
    `select p.consumed_at, p.key_wrap from oauth_payloads p join connections c on p.grant_id = c.grant_id
     where c.id = $1 and p.model = 'RefreshToken' and p.consumed_at is not null`,
    [connectionId]
  );
  return rows[0];
}

// Time passes in the database: the window is judged on its clock, not the app's.
async function ageUsedToken(connectionId: string, ms: number) {
  await db.query(
    `update oauth_payloads p set consumed_at = consumed_at - $2 * interval '1 millisecond' from connections c
     where p.grant_id = c.grant_id and c.id = $1 and p.model = 'RefreshToken' and p.consumed_at is not null`,
    [connectionId, ms]
  );
}

// Runs between find and the rotation of the next refresh.
function afterFind(run: () => Promise<void>) {
  const find = PgAdapter.prototype.find;
  vi.spyOn(PgAdapter.prototype, 'find').mockImplementationOnce(async function (
    this: InstanceType<typeof PgAdapter>,
    id
  ) {
    const seen = await find.call(this, id);
    await run();
    return seen;
  });
}

// A replica whose clock is off by skewMs. PGlite reads the same Date.now as the
// app, so every caller is skewed except the database's own clock read.
async function onReplica<T>(skewMs: number, run: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(realNow() + skewMs);
  const appNow = Date.now;
  Date.now = () => (new Error().stack!.split('\n')[2].includes('@electric-sql/pglite') ? realNow() : appNow());
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

describe('authorization server', () => {
  it('issues a five minute dir/A256GCM token that names the connection and carries its sealed key', async () => {
    const c = await connect();
    expect(c.status).toBe(200);
    expect(decodeProtectedHeader(c.access_token)).toMatchObject({ alg: 'dir', enc: 'A256GCM' });
    expect(Number(c.expires_in)).toBe(300);

    const claims = await claimsOf(c.access_token);
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: RESOURCE,
      client_id: 'jaw-cli',
      scope: 'wallet:read x402:pay',
    });
    const row = await findActive(claims.sub);
    expect(row?.account).toBe(c.signer.address);
    expect(await sessionAddressOf(c.access_token)).toBe(row?.sessionAddress);

    const auth = await verifyBearer(c.access_token);
    expect(auth?.extra?.tenant).toMatchObject({ connectionId: claims.sub, account: c.signer.address });
  });

  it('refuses an authorization request without PKCE', async () => {
    const start = await startAuthorization(new Browser(), { pkce: false });
    expect(start.uid).toBeUndefined();
    expect(start.redirected?.searchParams.get('error')).toBe('invalid_request');
    expect(start.redirected?.searchParams.get('error_description')).toMatch(/PKCE/);
  });

  it('accepts a CIMD client and names it with the domain of its metadata document', async () => {
    const start = await startAuthorization(new Browser(), { clientId: CIMD, redirectUri: 'http://127.0.0.1:9100/cb' });
    const page = start.html!;
    expect(page).toContain('Connect Example Agent');
    expect(page).toContain('<strong>client.example.test</strong>');
    const c = await connect(undefined, { clientId: CIMD, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(c.status).toBe(200);
  });

  it.each(['wallet:read x402:pay', 'openid offline_access wallet:read x402:pay'])(
    'accepts a CIMD client whose document declares the scope %s',
    async (scope) => {
      const c = await connect(undefined, { clientId: scoped(scope), redirectUri: 'http://127.0.0.1:9100/cb' });
      expect(c.status).toBe(200);
      expect(await claimsOf(c.access_token)).toMatchObject({ scope: 'wallet:read x402:pay' });
    }
  );

  it('shows the domain of a CIMD client named JAW CLI, which the official client has none of', async () => {
    const impostor = await startAuthorization(new Browser(), {
      clientId: IMPOSTOR,
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    expect(impostor.html!).toContain('<strong>evil.example.test</strong>');
    const official = await startAuthorization(new Browser());
    expect(official.html!).not.toContain('<strong>');
  });

  it('drops invisible characters from a declared name before showing it', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: HIDDEN_IMPOSTOR,
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    expect(start.html!).not.toMatch(/[\u00AD\u200B\u2060]/u);
  });

  it('escapes a declared name on the page', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: named('<img src=x onerror=alert(1)>'),
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    const page = start.html!;
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img');
  });

  it.each(['http://localhost:53123/callback', 'http://127.0.0.1:61001/callback'])(
    'accepts a CIMD client that registered loopback redirects without a port, on %s',
    async (redirectUri) => {
      const start = await startAuthorization(new Browser(), { clientId: LOOPBACK, redirectUri });
      expect(start.uid).toBeDefined();
    }
  );

  it('still refuses a loopback redirect on another path than the one registered', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: LOOPBACK,
      redirectUri: 'http://localhost:53123/elsewhere',
    });
    expect(start.uid).toBeUndefined();
  });

  it('refuses a CIMD client whose name Postgres cannot store, before consent', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: NUL_NAMED,
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    expect(start.uid).toBeUndefined();
  });

  it('refuses a CIMD client whose grant_types omit refresh_token, before consent', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: NO_REFRESH,
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    expect(start.uid).toBeUndefined();
    expect(await start.stopped?.text()).toMatch(/refresh_token/);
  });

  it('given a public CIMD client with a jwks_uri, when it asks to authorize, then it is refused', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: PUBLIC_KEYED,
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    expect(start.uid).toBeUndefined();
    expect(await start.stopped?.text()).toMatch(/client is not allowed/);
  });

  it('given a private_key_jwt CIMD client from any origin, when it asks to authorize, then it reaches consent', async () => {
    const start = await startAuthorization(new Browser(), { clientId: KEYED, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(start.stopped).toBeUndefined();
    expect(start.uid).toEqual(expect.any(String));
  });

  it('given a signing client whose jwks_uri is a local address, when it redeems its code, then invalid_client and no socket reaches it', async () => {
    const before = localSockets.length;
    const c = await connect(undefined, {
      clientId: LOCAL_KEYED,
      redirectUri: GEMINI_REDIRECT,
      clientAuth: await assertionFor(LOCAL_KEYED, geminiKey.privateKey),
    });
    expect(c.status).toBe(401);
    expect(c.error).toBe('invalid_client');
    expect(localSockets.length).toBe(before);
  });

  it('given ChatGPT, when it connects and refreshes with private_key_jwt, then both succeed', async () => {
    const c = await connect(undefined, {
      clientId: CHATGPT,
      redirectUri: CHATGPT_REDIRECT,
      clientAuth: await chatgptAssertion(),
    });
    expect(c.status).toBe(200);
    expect((await claimsOf(c.access_token)).client_id).toBe(CHATGPT);
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      client_id: CHATGPT,
      ...(await chatgptAssertion()),
    });
    expect(refreshed.status).toBe(200);
  });

  it('given ChatGPT, when a refresh response was lost and it retries with a new assertion, then 200 with the same refresh token', async () => {
    const c = await connect(undefined, {
      clientId: CHATGPT,
      redirectUri: CHATGPT_REDIRECT,
      clientAuth: await chatgptAssertion(),
    });
    const refresh = async () =>
      token({
        grant_type: 'refresh_token',
        refresh_token: c.refresh_token,
        client_id: CHATGPT,
        ...(await chatgptAssertion()),
      });
    const lost = await refresh();
    expect(lost.status).toBe(200);
    const retried = await refresh();
    expect(retried.status).toBe(200);
    expect(retried.body.refresh_token).toBe(lost.body.refresh_token);
  });

  it('given ChatGPT, when its token request carries no client assertion, then invalid_client', async () => {
    const c = await connect(undefined, { clientId: CHATGPT, redirectUri: CHATGPT_REDIRECT });
    expect(c.status).toBe(401);
    expect(c.error).toBe('invalid_client');
  });

  it('given ChatGPT, when its assertion is signed by a key outside its JWKS, then invalid_client', async () => {
    const other = await generateKeyPair('RS256');
    const c = await connect(undefined, {
      clientId: CHATGPT,
      redirectUri: CHATGPT_REDIRECT,
      clientAuth: await chatgptAssertion(other.privateKey),
    });
    expect(c.status).toBe(401);
    expect(c.error).toBe('invalid_client');
  });

  it('given ChatGPT, when it replays the assertion of its code exchange, then invalid_client', async () => {
    const assertion = await chatgptAssertion();
    const c = await connect(undefined, { clientId: CHATGPT, redirectUri: CHATGPT_REDIRECT, clientAuth: assertion });
    expect(c.status).toBe(200);
    const replayed = await token({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      client_id: CHATGPT,
      ...assertion,
    });
    expect(replayed.status).toBe(401);
    expect(replayed.body.error).toBe('invalid_client');
  });

  it("given a chatgpt.com public document naming ChatGPT's keys, when it asks to authorize, then it is refused", async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: CHATGPT_PUBLIC_KEYED,
      redirectUri: CHATGPT_REDIRECT,
    });
    expect(start.uid).toBeUndefined();
    expect(await start.stopped?.text()).toMatch(/client is not allowed/);
  });

  it('given a private_key_jwt document with inline keys, when it connects with an assertion signed by them, then it succeeds', async () => {
    const c = await connect(undefined, {
      clientId: CHATGPT_INLINE_KEYS,
      redirectUri: CHATGPT_REDIRECT,
      clientAuth: await assertionFor(CHATGPT_INLINE_KEYS, chatgptKey.privateKey),
    });
    expect(c.status).toBe(200);
  });

  it("given another origin's document naming ChatGPT's keys, when it signs with a key of its own, then its code exchange is refused", async () => {
    const other = await generateKeyPair('RS256');
    const c = await connect(undefined, {
      clientId: CHATGPT_KEYS_ELSEWHERE,
      redirectUri: CHATGPT_REDIRECT,
      clientAuth: await assertionFor(CHATGPT_KEYS_ELSEWHERE, other.privateKey),
    });
    expect(c.status).toBe(401);
    expect(c.error).toBe('invalid_client');
  });

  it('given Gemini, when it connects and refreshes with private_key_jwt, then both succeed', async () => {
    const c = await connect(undefined, {
      clientId: GEMINI,
      redirectUri: GEMINI_REDIRECT,
      clientAuth: await assertionFor(GEMINI, geminiKey.privateKey),
    });
    expect(c.status).toBe(200);
    const claims = await claimsOf(c.access_token);
    expect(claims.client_id).toBe(GEMINI);
    expect(claims.scope).toBe('wallet:read x402:pay');
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      client_id: GEMINI,
      ...(await assertionFor(GEMINI, geminiKey.privateKey)),
    });
    expect(refreshed.status).toBe(200);
  });

  it('given a chatgpt.com document whose grant_types omit refresh_token, when it asks to authorize, then it is refused', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: CHATGPT_NO_REFRESH,
      redirectUri: CHATGPT_REDIRECT,
    });
    expect(start.uid).toBeUndefined();
    expect(await start.stopped?.text()).toMatch(/refresh_token/);
  });

  it('refuses a redirect URI absent from the metadata document before consent', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: CIMD,
      redirectUri: 'http://127.0.0.1:9100/evil',
    });
    expect(start.uid).toBeUndefined();
    expect(start.stopped?.status).toBe(400);
    expect(await start.stopped?.text()).toMatch(/redirect_uri/);
  });

  it('rotates refresh tokens and revokes the connection when an old one is replayed after its successor', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const first = await refresh(c.refresh_token);
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(c.refresh_token);
    const second = await refresh(first.body.refresh_token);
    expect(second.status).toBe(200);

    const replay = await refresh(c.refresh_token);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await refresh(second.body.refresh_token)).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeUndefined();
    expect(await verifyBearer(second.body.access_token)).toBeUndefined();
  });

  it('given a refresh whose response was lost, when the client retries with the same token, then 200 with the same refresh token', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const lost = await refresh(c.refresh_token);
    expect(lost.status).toBe(200);

    const retried = await refresh(c.refresh_token);
    expect(retried.status).toBe(200);
    expect(retried.body.refresh_token).toBe(lost.body.refresh_token);
    expect(await liveRefreshTokens(sub)).toBe(1);
    expect(await verifyBearer(retried.body.access_token)).toBeDefined();
    expect(await sessionAddressOf(retried.body.access_token)).toBe(await sessionAddressOf(c.access_token));
    expect((await refresh(retried.body.refresh_token)).status).toBe(200);
    expect(await findActive(sub)).toBeDefined();
  });

  it('given a token used 60.5 s ago, when presented, then invalid_grant and its successor is refused too', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const first = await refresh(c.refresh_token);
    await ageUsedToken(sub, 60_500);
    expect((await refresh(c.refresh_token)).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeUndefined();
    expect((await refresh(first.body.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('given a second holder of the token, when it refreshes 30 s after the first, then 200 with the same refresh token', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const first = await refresh(c.refresh_token);
    await ageUsedToken(sub, 30_000);
    const second = await refresh(c.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toBe(first.body.refresh_token);
  });

  it('given a retry that returned the lost successor, when that successor is used and its lost copy comes 61 s later, then invalid_grant and the connection is ended', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    const retried = await refresh(c.refresh_token);
    expect((await refresh(retried.body.refresh_token)).status).toBe(200);
    await ageUsedToken(sub, 61_000);
    expect((await refresh(retried.body.refresh_token)).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeUndefined();
  });

  it('given two refreshes that saw the token live, when one rotates first, then both 200 with the same refresh token', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    let first: Awaited<ReturnType<typeof refresh>> | undefined;
    afterFind(async () => {
      first = await refresh(c.refresh_token);
    });
    const second = await refresh(c.refresh_token);
    expect(first?.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toBe(first?.body.refresh_token);
    expect(await liveRefreshTokens(sub)).toBe(1);
    expect((await refresh(second.body.refresh_token)).status).toBe(200);
  });

  it('given a retry that passed find, when another retry completes first, then both 200 with the same refresh token, which then refreshes', async () => {
    const c = await connect();
    await refresh(c.refresh_token);
    let first: Awaited<ReturnType<typeof refresh>> | undefined;
    afterFind(async () => {
      first = await refresh(c.refresh_token);
    });
    const second = await refresh(c.refresh_token);
    expect(first?.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toBe(first?.body.refresh_token);
    expect((await refresh(second.body.refresh_token)).status).toBe(200);
  });

  it('given a retry that passed find, when its successor is used before it rotates, then invalid_grant and the connection stays active', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const lost = await refresh(c.refresh_token);
    afterFind(async () => {
      expect((await refresh(lost.body.refresh_token)).status).toBe(200);
    });
    expect((await refresh(c.refresh_token)).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeDefined();
  });

  it('given a refresh that saw the token live, when another rotates it and the window passes before this one rotates, then invalid_grant and the connection stays active', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    afterFind(async () => {
      expect((await refresh(c.refresh_token)).status).toBe(200);
      await ageUsedToken(sub, 61_000);
    });
    expect((await refresh(c.refresh_token)).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeDefined();
  });

  it('given a successor stored under an id this build does not derive, when its token is retried, then invalid_grant and the connection stays active', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const lost = await refresh(c.refresh_token);
    const keyOf = (id: string) => createHash('sha256').update(`RefreshToken:${id}`).digest('hex');
    const [stored, random] = [keyOf(lost.body.refresh_token), keyOf('random-successor-of-an-older-build')];
    await db.query('update oauth_payloads set key = $2 where key = $1', [stored, random]);
    await db.query('update oauth_payloads set successor_key = $2 where successor_key = $1', [stored, random]);
    expect((await refresh(c.refresh_token)).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeDefined();
  });

  it('refuses a refresh whose connection is revoked after the account check, before the rotation', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const upsert = PgAdapter.prototype.upsert;
    vi.spyOn(PgAdapter.prototype, 'upsert').mockImplementationOnce(async function (
      this: InstanceType<typeof PgAdapter>,
      id,
      payload,
      expiresIn
    ) {
      await revokeByGrant(payload.grantId!);
      return upsert.call(this, id, payload, expiresIn);
    });
    const refreshed = await refresh(c.refresh_token);
    vi.restoreAllMocks();
    expect(refreshed.body.error).toBe('invalid_grant');
    expect(await liveRefreshTokens(sub)).toBe(1);
  });

  it('given a retry that passed find, when the connection is revoked before the rotation, then invalid_grant and no new token', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    const upsert = PgAdapter.prototype.upsert;
    vi.spyOn(PgAdapter.prototype, 'upsert').mockImplementationOnce(async function (
      this: InstanceType<typeof PgAdapter>,
      id,
      payload,
      expiresIn
    ) {
      await revokeByGrant(payload.grantId!);
      return upsert.call(this, id, payload, expiresIn);
    });
    const retried = await refresh(c.refresh_token);
    vi.restoreAllMocks();
    expect(retried.body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeUndefined();
    expect(await liveRefreshTokens(sub)).toBe(1);
  });

  it('never forks the refresh chain under concurrent refreshes or retries', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const parallel = await Promise.all([refresh(c.refresh_token), refresh(c.refresh_token)]);
    expect(parallel.map((r) => r.status)).toEqual([200, 200]);
    expect(parallel[1].body.refresh_token).toBe(parallel[0].body.refresh_token);
    expect(await liveRefreshTokens(sub)).toBe(1);

    const retries = await Promise.all([refresh(c.refresh_token), refresh(c.refresh_token)]);
    const successor = parallel[0].body.refresh_token;
    expect(retries.map((r) => r.body.refresh_token)).toEqual([successor, successor]);
    expect(await liveRefreshTokens(sub)).toBe(1);
    expect(await findActive(sub)).toBeDefined();
  });

  it('connects twice from the same browser, each time as a new connection', async () => {
    const browser = new Browser();
    const first = await connect(undefined, {}, browser);
    const second = await connect(undefined, {}, browser);
    expect(second.status).toBe(200);
    const [a, b] = [await claimsOf(first.access_token), await claimsOf(second.access_token)];
    expect(a.sub).not.toBe(b.sub);
    expect((await verifyBearer(second.access_token))?.extra?.tenant).toMatchObject({ account: second.signer.address });
  });

  it('given a second connection from the same browser approved twenty minutes in, then it still gets its tokens', async () => {
    const browser = new Browser();
    await connect(undefined, {}, browser);
    // Twenty minutes pass while the owner approves in the wallet.
    setWallet({
      verify: async (a) => {
        await db.query(
          `update oauth_payloads set expires_at = expires_at - interval '20 minutes' where expires_at is not null`
        );
        return verifyLocally(a);
      },
    });
    const second = await connect(undefined, {}, browser).finally(() => setWallet({ verify: verifyLocally }));
    expect(second.status).toBe(200);
  });

  it('a database dump and the sealing keys recover no session key', async () => {
    const c = await connect();
    const first = await refresh(c.refresh_token);
    const second = await refresh(first.body.refresh_token);
    const { sub, sk } = await claimsOf(second.body.access_token);
    const key = open(config().ring, sk, sub);

    const dump = await dumpStrings();
    expect(dump.some((s) => s.includes(key.slice(2)))).toBe(false);
    expect(recoverable(dump, config().ring, sub, [])).toEqual([]);
    expect(recoverable(dump, config().ring, sub, [second.body.refresh_token])).toEqual([privateKeyToAddress(key)]);
    expect(recoverable(dump, config().ring, sub, [c.refresh_token])).toEqual([]);
  });

  it('given a used token past the window whose wrap was swept, then the dump and the session key derive no successor from it', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const next = await refresh(c.refresh_token);
    const key = open(config().ring, (await claimsOf(next.body.access_token)).sk, sub);
    const derives = async () =>
      (await dumpStrings()).some((s) => nextRefreshId(key, c.refresh_token, s as never) === next.body.refresh_token);
    expect(await derives()).toBe(true);
    await ageUsedToken(sub, 61_000);
    await refresh((await connect()).refresh_token);
    expect(await derives()).toBe(false);
  });

  it('given a used token past the window, when another connection rotates, then its wrap is gone', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(sub, 61_000);
    await refresh((await connect()).refresh_token);
    expect(recoverable(await dumpStrings(), config().ring, sub, [c.refresh_token])).toEqual([]);
  });

  it('given a retry admitted at 59 s, when its token passes the window before the rotation, then 200', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(sub, 59_000);
    afterFind(() => ageUsedToken(sub, 2_000));
    expect((await refresh(c.refresh_token)).status).toBe(200);
  });

  it('given a retry admitted at 59.5 s, when another rotation sweeps its stored wrap meanwhile, then 200 with the same key and successor', async () => {
    const c = await connect();
    const other = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const lost = await refresh(c.refresh_token);
    await ageUsedToken(sub, 59_500);
    afterFind(async () => {
      await ageUsedToken(sub, 2_000);
      expect((await refresh(other.refresh_token)).status).toBe(200);
      expect((await usedToken(sub)).key_wrap).toBeNull();
    });
    const retried = await refresh(c.refresh_token);
    expect(retried.status).toBe(200);
    expect(retried.body.refresh_token).toBe(lost.body.refresh_token);
    expect(await sessionAddressOf(retried.body.access_token)).toBe(await sessionAddressOf(c.access_token));
  });

  it('given a retry that rotates after its token passed the window, then that token keeps no wrap', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(sub, 59_500);
    afterFind(() => ageUsedToken(sub, 2_000));
    expect((await refresh(c.refresh_token)).status).toBe(200);
    expect(recoverable(await dumpStrings(), config().ring, sub, [c.refresh_token])).toEqual([]);
  });

  it('keeps the session key sealed until the code exchange, and only the refresh token opens it after', async () => {
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    const select = 'select id, session_address, sealed_key from connections where interaction_uid = $1';
    const [pending] = (
      await db.query<{ id: string; session_address: string; sealed_key: string | null }>(select, [start.uid])
    ).rows;
    // Between the wallet's approval and the exchange, the ring opens it: the permission names it as spender.
    expect(privateKeyToAddress(open(config().ring, pending.sealed_key as never, pending.id))).toBe(
      pending.session_address
    );

    const redirected = await follow(browser, `${ISSUER}/interaction/${start.uid}/complete?ticket=${start.ticket}`);
    const issued = await token({
      grant_type: 'authorization_code',
      code: redirected.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id: 'jaw-cli',
      code_verifier: start.verifier,
      resource: RESOURCE,
    });
    expect(issued.status).toBe(200);
    expect(await sessionAddressOf(issued.body.access_token)).toBe(pending.session_address);
    const [after] = (await db.query<{ sealed_key: string | null }>(select, [start.uid])).rows;
    expect(after.sealed_key).toBeNull();
    expect(recoverable(await dumpStrings(), config().ring, pending.id, [])).toEqual([]);
  });

  it('given a code exchange whose refresh token fails to store, then the session key is sealed again for the reconciler', async () => {
    const browser = new Browser();
    const start = await startAuthorization(browser);
    await walletsSettled();
    const redirected = await follow(browser, `${ISSUER}/interaction/${start.uid}/complete?ticket=${start.ticket}`);
    await db.exec(`
      create or replace function fail_refresh() returns trigger language plpgsql as $$
      begin
        raise exception 'refresh token refused';
      end $$;
      create or replace trigger fail_refresh before insert on oauth_payloads
        for each row when (new.model = 'RefreshToken') execute function fail_refresh();`);
    try {
      const issued = await token({
        grant_type: 'authorization_code',
        code: redirected.searchParams.get('code')!,
        redirect_uri: REDIRECT,
        client_id: 'jaw-cli',
        code_verifier: start.verifier,
        resource: RESOURCE,
      });
      expect(issued.status).not.toBe(200);
    } finally {
      await db.exec('drop trigger if exists fail_refresh on oauth_payloads');
    }
    const [row] = (
      await db.query<{ id: string; session_address: string; sealed_key: string | null }>(
        'select id, session_address, sealed_key from connections where interaction_uid = $1',
        [start.uid]
      )
    ).rows;
    expect(row.sealed_key).not.toBeNull();
    expect(privateKeyToAddress(open(config().ring, row.sealed_key as never, row.id))).toBe(row.session_address);
  });

  it('keeps the session key across refresh rotations', async () => {
    const c = await connect();
    const address = await sessionAddressOf(c.access_token);
    let current = c.refresh_token;
    for (let i = 0; i < 3; i++) {
      const r = await refresh(current);
      expect(r.status).toBe(200);
      expect(await sessionAddressOf(r.body.access_token)).toBe(address);
      current = r.body.refresh_token;
    }
  });

  it('moves a connection to the newest sealing key on its next refresh', async () => {
    const c = await connect();
    const address = await sessionAddressOf(c.access_token);
    const newest = randomBytes(32).toString('base64url');
    const rotated = parseKeyRing(`${newest},${process.env.JAW_MCP_SEALING_KEYS}`);
    const r = await withRing(rotated, () => refresh(c.refresh_token));
    expect(await sessionAddressOf(r.body.access_token, rotated)).toBe(address);

    const onlyNewest = parseKeyRing(newest);
    const after = await withRing(onlyNewest, () => refresh(r.body.refresh_token));
    expect(after.status).toBe(200);
    expect(await sessionAddressOf(after.body.access_token, onlyNewest)).toBe(address);
  });

  it('a refresh that needs a dropped sealing key fails without spending the token', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const failed = await withRing(parseKeyRing(randomBytes(32).toString('base64url')), () => refresh(c.refresh_token));
    expect(failed.status).toBe(500);

    const retried = await refresh(c.refresh_token);
    expect(retried.status).toBe(200);
    expect(await findActive(sub)).toBeDefined();
  });

  it('given a revocation of a refresh token whose sealing key left the ring, then 200 and the connection ends', async () => {
    const { oauth } = await import('./provider');
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const revoked = await withRing(parseKeyRing(randomBytes(32).toString('base64url')), () =>
      oauth(
        new Request(`${ISSUER}/oauth/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: c.refresh_token, token_type_hint: 'refresh_token', client_id: 'jaw-cli' }),
        })
      )
    );
    expect(revoked.status).toBe(200);
    expect(await findActive(sub)).toBeUndefined();
  });

  it('builds discovery URLs from the configured public URL, never from forwarded headers', async () => {
    const { oauth } = await import('./provider');
    const res = await oauth(
      new Request(`${ISSUER}/.well-known/openid-configuration`, {
        headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
      })
    );
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('evil.example');
    expect(JSON.parse(body).token_endpoint).toBe(`${ISSUER}/oauth/token`);
  });

  it('adds wallet:read to a request with no scope without touching a loopback redirect', async () => {
    const { oauth } = await import('./provider');
    const { NextRequest } = await import('next/server');
    const params = new URLSearchParams({
      client_id: 'jaw-cli',
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 's',
      resource: RESOURCE,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });
    const res = await oauth(new NextRequest(`${ISSUER}/oauth/authorize?${params}`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/interaction\//);
  });

  it('advertises the wallet scopes in the authorization server metadata', async () => {
    const { oauth } = await import('./provider');
    for (const path of ['openid-configuration', 'oauth-authorization-server']) {
      const res = await oauth(new Request(`${ISSUER}/.well-known/${path}`));
      expect((await res.json()).scopes_supported, path).toEqual(expect.arrayContaining(['wallet:read', 'x402:pay']));
    }
  });

  it('advertises only endpoints it serves: no pushed authorization requests', async () => {
    const { oauth } = await import('./provider');
    const res = await oauth(new Request(`${ISSUER}/.well-known/openid-configuration`));
    expect(await res.json()).not.toHaveProperty('pushed_authorization_request_endpoint');
  });

  it('answers a NUL in the authorization request with a client error, not a 500', async () => {
    const { oauth } = await import('./provider');
    const params = new URLSearchParams({
      client_id: 'jaw-cli',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'wallet:read',
      state: 'a\u0000b',
      resource: RESOURCE,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });
    const res = await oauth(new Request(`${ISSUER}/oauth/authorize?${params}`));
    expect(res.status).toBeLessThan(500);
  });

  it('refuses a token for another resource', async () => {
    const c = await connect();
    const other = await token({
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token,
      client_id: 'jaw-cli',
      resource: 'https://other.example/mcp',
    });
    expect(other.body.error).toBe('invalid_target');
    const start = await startAuthorization(new Browser(), { resource: 'https://other.example/mcp' });
    expect(start.redirected?.searchParams.get('error')).toBe('invalid_target');
  });

  it('rejects tokens it did not issue or that are expired', async () => {
    expect(await verifyBearer('not-a-token')).toBeUndefined();
    expect(await verifyBearer(undefined)).toBeUndefined();
    const c = await connect();
    const [h, k, iv, ct, tag] = c.access_token.split('.');
    const tampered = Buffer.from(ct, 'base64url');
    tampered[0] ^= 1;
    expect(await verifyBearer([h, k, iv, tampered.toString('base64url'), tag].join('.'))).toBeUndefined();
  });
});

const FIVE_MINUTES = 5 * 60_000;

describe('given replicas whose clocks disagree by five minutes', () => {
  it('when a retry 5 s after the rotation reaches a replica ahead, then 200 with the same key', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(sub, 5_000);
    const retried = await onReplica(FIVE_MINUTES, () => refresh(c.refresh_token));
    expect(retried.status).toBe(200);
    expect(await sessionAddressOf(retried.body.access_token)).toBe(await sessionAddressOf(c.access_token));
    expect(await findActive(sub)).toBeDefined();
  });

  it('when a token used 61 s ago reaches a replica behind, then invalid_grant and revoked', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(sub, 61_000);
    expect((await onReplica(-FIVE_MINUTES, () => refresh(c.refresh_token))).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeUndefined();
  });

  it('when a replica behind rotates, then a retry 5 s later on a correct replica answers 200', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await onReplica(-FIVE_MINUTES, () => refresh(c.refresh_token));
    await ageUsedToken(sub, 5_000);
    expect((await refresh(c.refresh_token)).status).toBe(200);
    expect(await findActive(sub)).toBeDefined();
  });

  it('when a replica ahead rotates and 61 s pass, then a correct replica answers invalid_grant', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await onReplica(FIVE_MINUTES, () => refresh(c.refresh_token));
    await ageUsedToken(sub, 61_000);
    expect((await refresh(c.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('when another connection rotates on a replica behind, then a wrap used 61 s ago is gone', async () => {
    const c = await connect();
    const other = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(sub, 61_000);
    await onReplica(-FIVE_MINUTES, () => refresh(other.refresh_token));
    expect((await usedToken(sub)).key_wrap).toBeNull();
    expect(recoverable(await dumpStrings(), config().ring, sub, [c.refresh_token])).toEqual([]);
  });

  it('when another connection rotates on a replica ahead, then a wrap used 5 s ago is kept for its retry', async () => {
    const c = await connect();
    const other = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(sub, 5_000);
    await onReplica(FIVE_MINUTES, () => refresh(other.refresh_token));
    const retried = await refresh(c.refresh_token);
    expect(retried.status).toBe(200);
    expect(await sessionAddressOf(retried.body.access_token)).toBe(await sessionAddressOf(c.access_token));
  });
});

describe('given a rotation that waits 2 s on the connection row lock', () => {
  it('when it commits, then the window starts after the wait', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    let released = 0;
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce((run) =>
      transaction((tx) => {
        const query = tx.query.bind(tx);
        tx.query = (async (text: string, ...rest: never[]) => {
          if (text.includes('for share')) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            released = Date.now();
          }
          return query(text, ...rest);
        }) as typeof tx.query;
        return run(tx);
      })
    );
    expect((await refresh(c.refresh_token)).status).toBe(200);
    expect(new Date((await usedToken(sub)).consumed_at).getTime()).toBeGreaterThanOrEqual(released);
  });
});

describe('given the sweep after a rotation fails', () => {
  let stranded: string;
  // Connecting rotates too, so these exist before the stranded wrap does.
  let first: Awaited<ReturnType<typeof connect>>;
  let second: Awaited<ReturnType<typeof connect>>;

  // Raises on nulling a wrap already past the window, which only the sweep does
  // on a chain whose predecessor is inside the window or already swept.
  const failSweep = (errcode: string) =>
    db.exec(`
      create or replace function fail_sweep() returns trigger language plpgsql as $$
      begin
        if new.key_wrap is null and old.key_wrap is not null and old.consumed_at < now() - interval '60 seconds' then
          raise exception 'sweep refused' using errcode = '${errcode}';
        end if;
        return new;
      end $$;
      create or replace trigger fail_sweep before update on oauth_payloads
        for each row execute function fail_sweep();`);

  beforeEach(async () => {
    [first, second] = [await connect(), await connect()];
    const c = await connect();
    stranded = (await claimsOf(c.access_token)).sub;
    await refresh(c.refresh_token);
    await ageUsedToken(stranded, 61_000);
  });

  afterEach(async () => {
    await db.exec('drop trigger if exists fail_sweep on oauth_payloads');
  });

  it('when a refresh rotates, then 200, a working pair, and one error line with the label only', async () => {
    await failSweep('P0001');
    const sub = (await claimsOf(first.access_token)).sub;
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rotated = await refresh(first.refresh_token);
    const lines = logged.mock.calls.map(([line]) => String(line)).filter((l) => l.includes('wrap sweep failed'));
    logged.mockRestore();
    expect(rotated.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: 'error',
      time: expect.any(String),
      msg: 'wrap sweep failed',
      error: expect.stringMatching(/^\w+ P0001$/),
    });
    expect(await verifyBearer(rotated.body.access_token)).toBeDefined();
    expect((await refresh(rotated.body.refresh_token)).status).toBe(200);
    expect(await findActive(sub)).toBeDefined();
  });

  it('when the sweep fails with a connection error, then the refresh still answers 200', async () => {
    await failSweep('08006');
    const rotated = await refresh(first.refresh_token);
    expect(rotated.status).toBe(200);
    expect((await refresh(rotated.body.refresh_token)).status).toBe(200);
  });

  it('when the trigger is gone and another connection rotates, then the stranded wrap is gone', async () => {
    await failSweep('P0001');
    await refresh(first.refresh_token);
    await db.exec('drop trigger fail_sweep on oauth_payloads');
    await refresh(second.refresh_token);
    expect((await usedToken(stranded)).key_wrap).toBeNull();
  });
});

describe('sliding connection expiry', () => {
  it('a successful refresh extends the connection expiry', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const before = await db.query<{ expires_at: Date }>(`select expires_at from connections where id = $1`, [sub]);
    const oldExpiry = before.rows[0].expires_at.getTime();

    // Move the clock forward by 1 day on the connection row so the slide is visible.
    await db.query(`update connections set expires_at = expires_at - interval '1 day' where id = $1`, [sub]);
    const shifted = await db.query<{ expires_at: Date }>(`select expires_at from connections where id = $1`, [sub]);
    const shiftedExpiry = shifted.rows[0].expires_at.getTime();
    expect(shiftedExpiry).toBeLessThan(oldExpiry);

    const r = await refresh(c.refresh_token);
    expect(r.status).toBe(200);

    const after = await db.query<{ expires_at: Date }>(`select expires_at from connections where id = $1`, [sub]);
    const newExpiry = after.rows[0].expires_at.getTime();
    // The expiry was extended past the shifted value, back to about 30 days from now.
    expect(newExpiry).toBeGreaterThan(shiftedExpiry);
    expect(newExpiry).toBeGreaterThanOrEqual(oldExpiry);
  });

  it('a retry does not double-extend the expiry', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const lost = await refresh(c.refresh_token);
    expect(lost.status).toBe(200);

    const {
      rows: [{ expires_at: afterFirst }],
    } = await db.query<{ expires_at: Date }>(`select expires_at from connections where id = $1`, [sub]);
    const retried = await refresh(c.refresh_token);
    expect(retried.status).toBe(200);

    const {
      rows: [{ expires_at: afterRetry }],
    } = await db.query<{ expires_at: Date }>(`select expires_at from connections where id = $1`, [sub]);
    // A retry re-issues the same successor, so the expiry moves at most a few ms.
    expect(Math.abs(afterRetry.getTime() - afterFirst.getTime())).toBeLessThan(5_000);
  });
});

describe('reuse sweep', () => {
  it('when a reused token still holds its wrap, the key is recovered for the sweep', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const first = await refresh(c.refresh_token);
    expect(first.status).toBe(200);

    // The used token carries a wrap for 60 s. Age it past the window so it
    // counts as reuse, but do not trigger another rotation (which would sweep
    // the wrap). The wrap is still on the row.
    await ageUsedToken(sub, 61_000);
    const token = await usedToken(sub);
    expect(token.key_wrap).not.toBeNull();

    // Spy on sweepOnReuse to verify the adapter calls it with the recovered key.
    const spy = vi.spyOn(await import('./disconnect'), 'sweepOnReuse').mockResolvedValue();

    const reused = await refresh(c.refresh_token);
    expect(reused.body.error).toBe('invalid_grant');
    expect(spy).toHaveBeenCalledWith(sub, expect.stringMatching(/^0x[0-9a-f]+$/));

    spy.mockRestore();
  });

  it('when the sweep fails, the reused token still ends the connection', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    expect((await refresh(c.refresh_token)).status).toBe(200);
    await ageUsedToken(sub, 61_000);
    const spy = vi.spyOn(await import('./disconnect'), 'sweepOnReuse').mockRejectedValue(new Error('chain down'));

    const reused = await refresh(c.refresh_token);
    expect(reused.body.error).toBe('invalid_grant');
    expect(spy).toHaveBeenCalled();
    expect(await findActive(sub)).toBeUndefined();

    spy.mockRestore();
  });

  it('when a reused token has no wrap, no sweep is attempted', async () => {
    const c = await connect();
    const first = await refresh(c.refresh_token);
    expect(first.status).toBe(200);

    // Using the successor nulls the predecessor's wrap (adapter.ts line 182).
    const second = await refresh(first.body.refresh_token);
    expect(second.status).toBe(200);

    const spy = vi.spyOn(await import('./disconnect'), 'sweepOnReuse').mockResolvedValue();

    // The original token's wrap was nulled, so the adapter cannot recover the key.
    const reused = await refresh(c.refresh_token);
    expect(reused.body.error).toBe('invalid_grant');
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
