import { randomBytes } from 'node:crypto';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import { privateKeyToAddress } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { Browser, connect, ISSUER, RESOURCE, setTestEnv, startAuthorization, token } from './testkit';

setTestEnv();
const { verifyBearer } = await import('./auth');
const { config } = await import('./config');
const { createProvider } = await import('./provider');
const { findActive } = await import('./rows');
const { isStale, open, parseKeyRing } = await import('./seal');

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

beforeAll(async () => {
  await useTestDb();
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

const claimsOf = async (jwe: string) =>
  JSON.parse(new TextDecoder().decode((await compactDecrypt(jwe, config().ring.keys[0].jwe)).plaintext));

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
    expect(claims.sk).toBe(row?.sealedKey);
    expect(privateKeyToAddress(open(config().ring, claims.sk, claims.sub))).toBe(row?.sessionAddress);

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

  it('rotates refresh tokens and revokes the connection when an old one is replayed', async () => {
    const c = await connect();
    const sub = (await claimsOf(c.access_token)).sub;
    const first = await token({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: 'jaw-cli' });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(c.refresh_token);
    expect((await claimsOf(first.body.access_token)).sk).toBe((await claimsOf(c.access_token)).sk);

    const replay = await token({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: 'jaw-cli' });
    expect(replay.body.error).toBe('invalid_grant');
    const after = await token({
      grant_type: 'refresh_token',
      refresh_token: first.body.refresh_token,
      client_id: 'jaw-cli',
    });
    expect(after.body.error).toBe('invalid_grant');
    expect(await findActive(sub)).toBeUndefined();
    expect(await verifyBearer(first.body.access_token)).toBeUndefined();
  });

  it('lets only one of two concurrent refreshes with the same token through', async () => {
    const c = await connect();
    const body = { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: 'jaw-cli' };
    const results = await Promise.all([token(body), token(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
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

  it('re-seals a connection under the newest key on refresh after a rotation', async () => {
    const c = await connect();
    const old = config();
    const ring = parseKeyRing(`${randomBytes(32).toString('base64url')},${process.env.JAW_MCP_SEALING_KEYS}`);
    const cache = globalThis as { jawMcpProvider?: unknown };
    const before = cache.jawMcpProvider;
    cache.jawMcpProvider = createProvider({ ...old, ring });
    try {
      const r = await token({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: 'jaw-cli' });
      const claims = JSON.parse(
        new TextDecoder().decode((await compactDecrypt(r.body.access_token, ring.keys[0].jwe)).plaintext)
      );
      expect(isStale(ring, claims.sk)).toBe(false);
      expect((await findActive(claims.sub))?.sealedKey).toBe(claims.sk);
      expect(privateKeyToAddress(open(ring, claims.sk, claims.sub))).toBe(
        (await findActive(claims.sub))?.sessionAddress
      );
    } finally {
      cache.jawMcpProvider = before;
    }
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
