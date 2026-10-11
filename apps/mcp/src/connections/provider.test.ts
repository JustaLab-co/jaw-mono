import { createHash, randomBytes } from 'node:crypto';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import type { PGlite } from '@electric-sql/pglite';
import type { Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('node:dns', async (original) => {
  const dns = await original<typeof import('node:dns')>();
  const lookup = ((host: string, opts: object, cb: (...a: unknown[]) => void) =>
    host.endsWith('.example.test')
      ? cb(null, [{ address: '93.184.216.34', family: 4 }])
      : dns.lookup(host, opts, cb)) as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});

setTestEnv();
const { verifyBearer } = await import('./auth');
const { config } = await import('./config');
const { createProvider } = await import('./provider');
const { PgAdapter } = await import('./adapter');
const { findActive, revokeByGrant } = await import('./rows');
const { nextRefreshId, open, parseKeyRing, unwrap } = await import('./seal');
type KeyRing = ReturnType<typeof parseKeyRing>;

const CIMD = 'https://client.example.test/agent.json';
const IMPOSTOR = 'https://evil.example.test/jaw.json';
const HIDDEN_IMPOSTOR = 'https://evil.example.test/hidden.json';
const NAMED = 'https://named.example.test/';
const named = (name: string) => `${NAMED}${encodeURIComponent(name)}.json`;
const NUL_NAMED = 'https://evil.example.test/nul.json';
const KEYED = 'https://evil.example.test/keyed.json';
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
            : String(url) === KEYED
              ? Response.json({
                  ...metadata,
                  client_id: KEYED,
                  token_endpoint_auth_method: 'private_key_jwt',
                  jwks_uri: 'https://evil.example.test/jwks.json',
                })
              : String(url) === NUL_NAMED
                ? Response.json({ ...metadata, client_id: NUL_NAMED, client_name: 'Agent\u0000' })
                : String(url).startsWith(NAMED)
                  ? Response.json({
                      ...metadata,
                      client_id: String(url),
                      client_name: decodeURIComponent(String(url).slice(NAMED.length, -'.json'.length)),
                    })
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
      scope: 'wallet:read x402:pay wallet:send',
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
    expect(c.details.typedData.message.clientId).toBe(IMPOSTOR);
  });

  it('judges the declared name before sanitizing it on the consent path', async () => {
    const c = await connect(undefined, { clientId: HIDDEN_IMPOSTOR, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(c.details.client).toMatchObject({ official: false, reservedName: true });
    expect(c.details.client.name).not.toContain('\u200B');
  });

  it.each([
    'J\u200BAW',
    'J\u00ADaw',
    'J\u2060aw',
    'ja\u3164w',
    'JawWallet',
    'MyJaw',
    'JAWApp',
    'JAWwallet',
    '\u1D0A\u1D00\u1D21',
  ])('warns on the consent screen for a CIMD client named %j', async (name) => {
    const start = await startAuthorization(new Browser(), {
      clientId: named(name),
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    const { client } = await getDetails(start.uid!);
    expect(client).toMatchObject({ official: false, reservedName: true });
    expect(client.name).not.toMatch(/[\u00AD\u200B\u2060\u3164]/u);
  });

  it.each(['Mijaw', 'Jawbone', 'Raj Awesome', 'Jaws'])(
    'does not warn on the consent screen for a CIMD client named %j',
    async (name) => {
      const start = await startAuthorization(new Browser(), {
        clientId: named(name),
        redirectUri: 'http://127.0.0.1:9100/cb',
      });
      expect((await getDetails(start.uid!)).client).toMatchObject({ name, reservedName: false });
    }
  );

  it('refuses a CIMD client whose name Postgres cannot store, before consent', async () => {
    const start = await startAuthorization(new Browser(), {
      clientId: NUL_NAMED,
      redirectUri: 'http://127.0.0.1:9100/cb',
    });
    expect(start.uid).toBeUndefined();
  });

  it('refuses a CIMD client that authenticates with keys from a jwks_uri', async () => {
    const start = await startAuthorization(new Browser(), { clientId: KEYED, redirectUri: 'http://127.0.0.1:9100/cb' });
    expect(start.uid).toBeUndefined();
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

  it('creates the session key at the code exchange, never at consent', async () => {
    const browser = new Browser();
    const signer = owner();
    const start = await startAuthorization(browser);
    const d = await getDetails(start.uid!);
    const consented = await postConsent(start.uid!, signer.address, await signer.signTypedData(d.typedData));
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
      expect((await res.json()).scopes_supported, path).toEqual(
        expect.arrayContaining(['wallet:read', 'x402:pay', 'wallet:send'])
      );
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
    expect(await verifyBearer([h, k, iv, ct.slice(0, -2) + 'AA', tag].join('.'))).toBeUndefined();
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
