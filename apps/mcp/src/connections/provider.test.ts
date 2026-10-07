import { randomBytes } from 'node:crypto';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import type { PGlite } from '@electric-sql/pglite';
import type { Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDb } from '@/db/test-db';
import {
  Browser,
  connect,
  follow,
  getDetails,
  ISSUER,
  owner,
  postConsent,
  REDIRECT,
  RESOURCE,
  setTestEnv,
  startAuthorization,
  token,
} from './testkit';

setTestEnv();
const { verifyBearer } = await import('./auth');
const { config } = await import('./config');
const { createProvider } = await import('./provider');
const { RETRY_WINDOW_MS } = await import('./adapter');
const { findActive } = await import('./rows');
const { open, parseKeyRing, unwrap } = await import('./seal');
type KeyRing = ReturnType<typeof parseKeyRing>;

const CIMD = 'https://client.example.test/agent.json';
const IMPOSTOR = 'https://evil.example.test/jaw.json';
const HIDDEN_IMPOSTOR = 'https://evil.example.test/hidden.json';
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

/** Every string any table holds, as a database dump would show it. */
async function dumpStrings(): Promise<string[]> {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') found.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const table of ['settings', 'rate_limits', 'oauth_payloads', 'connections', 'approval_requests']) {
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

describe('authorization server', () => {
  it('issues a five minute dir/A256GCM token that names the connection and carries its sealed key', async () => {
    const c = await connect();
    expect(c.status).toBe(200);
    expect(decodeProtectedHeader(c.access_token)).toMatchObject({ alg: 'dir', enc: 'A256GCM' });
    expect(Number(c.expires_in)).toBe(300);

    const claims = await claimsOf(c.access_token);
    expect(claims).toMatchObject({ iss: ISSUER, aud: RESOURCE, client_id: 'jaw-cli', scope: 'wallet:read' });
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

  it('accepts a CIMD client and shows the name from its metadata document', async () => {
    const c = await connect(undefined, { clientId: CIMD, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(c.status).toBe(200);
    expect(c.details.client).toEqual({
      clientId: CIMD,
      name: 'Example Agent',
      host: 'client.example.test',
      official: false,
      reservedName: false,
    });
  });

  it('never lets a CIMD client named JAW CLI pass as the official client', async () => {
    const c = await connect(undefined, { clientId: IMPOSTOR, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(c.details.client).toMatchObject({ host: 'evil.example.test', official: false, reservedName: true });
    expect(c.details.message).toContain(`Client ID: ${IMPOSTOR}`);
  });

  it('judges the declared name before sanitizing it on the consent path', async () => {
    const c = await connect(undefined, { clientId: HIDDEN_IMPOSTOR, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(c.details.client).toMatchObject({ official: false, reservedName: true });
    expect(c.details.client.name).not.toContain('\u200B');
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

  it('answers a retry after a lost response with a working pair', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const lost = await refresh(c.refresh_token);
    expect(lost.status).toBe(200);

    const retried = await refresh(c.refresh_token);
    expect(retried.status).toBe(200);
    expect(retried.body.refresh_token).not.toBe(lost.body.refresh_token);
    expect(await verifyBearer(retried.body.access_token)).toBeDefined();
    expect(await sessionAddressOf(retried.body.access_token)).toBe(await sessionAddressOf(c.access_token));
    expect((await refresh(retried.body.refresh_token)).status).toBe(200);
    expect(await findActive(sub)).toBeDefined();
  });

  it('revokes the connection on reuse after the retry window', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const first = await refresh(c.refresh_token);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + RETRY_WINDOW_MS + 1000);
      expect((await refresh(c.refresh_token)).body.error).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
    expect(await findActive(sub)).toBeUndefined();
    expect((await refresh(first.body.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('revokes the connection when the successor a retry replaced is presented', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const replaced = await refresh(c.refresh_token);
    const retried = await refresh(c.refresh_token);
    expect(retried.status).toBe(200);

    expect((await refresh(replaced.body.refresh_token)).body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeUndefined();
    expect((await refresh(retried.body.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('never forks the refresh chain under concurrent refreshes or retries', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const parallel = await Promise.all([refresh(c.refresh_token), refresh(c.refresh_token)]);
    expect(parallel.some((r) => r.status === 200)).toBe(true);
    expect(await liveRefreshTokens(sub)).toBe(1);

    const retries = await Promise.all([refresh(c.refresh_token), refresh(c.refresh_token)]);
    expect(retries.some((r) => r.status === 200)).toBe(true);
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
  });

  it('creates the session key at the code exchange, never at consent', async () => {
    const browser = new Browser();
    const signer = owner();
    const start = await startAuthorization(browser);
    const d = await getDetails(start.uid!);
    const consented = await postConsent(start.uid!, signer.address, await signer.signMessage({ message: d.message }));
    const redirected = await follow(browser, ((await consented.json()) as { next: string }).next);

    const [row] = (
      await db.query<{ id: string; session_address: string | null }>(
        'select id, session_address from connections where interaction_uid = $1',
        [start.uid]
      )
    ).rows;
    expect(row.session_address).toBeNull();
    expect(recoverable(await dumpStrings(), config().ring, row.id, [])).toEqual([]);

    const issued = await token({
      grant_type: 'authorization_code',
      code: redirected.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id: 'jaw-cli',
      code_verifier: start.verifier,
      resource: RESOURCE,
    });
    expect(issued.status).toBe(200);
    expect((await findActive(row.id))?.sessionAddress).toBe(await sessionAddressOf(issued.body.access_token));
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
    expect(await verifyBearer([h, k, iv, ct.slice(0, -2) + 'AA', tag].join('.'))).toBeUndefined();
  });
});
