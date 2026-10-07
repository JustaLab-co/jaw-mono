import { FIRST_PARTY_CLIENTS } from '@jaw.id/agent';
import Provider, { errors, interactionPolicy, type Configuration } from 'oidc-provider';
import { databaseUnreachable, log } from '@/lib/edge';
import { PgAdapter } from './adapter';
import { bridge } from './bridge';
import { config, type Config } from './config';
import { findActive, updateSealedKey } from './rows';
import { isStale, open, seal, type Sealed } from './seal';

export const SCOPES = { 'wallet:read': 'See your account and balances, and ask you to approve signatures' } as const;
export type Scope = keyof typeof SCOPES;

const DAY = 24 * 60 * 60;

// Native loopback redirects match on any port.
const JAW_CLI = {
  client_id: 'jaw-cli',
  client_name: FIRST_PARTY_CLIENTS['jaw-cli'],
  application_type: 'native' as const,
  token_endpoint_auth_method: 'none' as const,
  redirect_uris: ['http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code' as const],
};

// Re-seals under the newest key when the row still uses an older one.
async function sealedKeyFor(cfg: Config, connectionId: string): Promise<Sealed> {
  const row = await findActive(connectionId);
  if (!row) throw new Error('connection is not active');
  const sealed = row.sealedKey as Sealed;
  if (!isStale(cfg.ring, sealed)) return sealed;
  const fresh = seal(cfg.ring, open(cfg.ring, sealed, row.id), row.id);
  await updateSealedKey(row.id, fresh);
  return fresh;
}

export function createProvider(cfg: Config, overrides: Partial<Configuration> = {}): Provider {
  const policy = interactionPolicy.base();
  // No session reuse: every authorization goes through consent and makes its own connection.
  policy
    .get('login')!
    .checks.add(
      new interactionPolicy.Check('new_connection', 'every authorization creates a connection', (ctx) =>
        ctx.oidc.result?.login ? interactionPolicy.Check.NO_NEED_TO_PROMPT : interactionPolicy.Check.REQUEST_PROMPT
      )
    );

  const provider = new Provider(cfg.issuer, {
    adapter: PgAdapter,
    clients: [JAW_CLI],
    clientDefaults: { id_token_signed_response_alg: 'EdDSA' },
    findAccount: async (_ctx, sub) =>
      (await findActive(sub)) ? { accountId: sub, claims: () => ({ sub }) } : undefined,
    pkce: { required: () => true },
    rotateRefreshToken: true,
    expiresWithSession: () => false,
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    ttl: { AuthorizationCode: 60, Interaction: 600, Session: 600, Grant: 30 * DAY, RefreshToken: 30 * DAY },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}`, policy },
    cookies: { keys: cfg.ring.keys.map((k) => k.cookie) },
    jwks: { keys: [cfg.ring.jwk as never] },
    routes: {
      authorization: '/oauth/authorize',
      token: '/oauth/token',
      revocation: '/oauth/revoke',
      jwks: '/oauth/jwks',
      end_session: '/oauth/logout',
      userinfo: '/oauth/userinfo',
    },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      revocation: { enabled: true },
      clientIdMetadataDocument: { enabled: true, ack: 'draft-02' },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => cfg.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== cfg.resource) throw new errors.InvalidTarget();
          return {
            scope: Object.keys(SCOPES).join(' '),
            audience: cfg.resource,
            accessTokenTTL: 300,
            accessTokenFormat: 'jwt',
            jwt: {
              sign: false,
              encrypt: { alg: 'dir', enc: 'A256GCM', key: cfg.ring.keys[0].jwe, kid: cfg.ring.keys[0].kid },
            },
          };
        },
      },
    },
    extraTokenClaims: async (_ctx, token) =>
      token.kind === 'AccessToken' ? { sk: await sealedKeyFor(cfg, token.accountId) } : undefined,
    ...overrides,
  });
  provider.proxy = true;
  provider.on('server_error', (ctx: { state: Record<string, unknown> }, err: Error) => {
    if (databaseUnreachable(err)) ctx.state.databaseUnreachable = true;
    log('error', { msg: 'oauth server error', error: err.name });
  });
  // The provider renders its own 500 for errors in its routes; a database
  // outage should read as one, like everywhere else on this server.
  provider.use(async (ctx, next) => {
    await next();
    if (!ctx.state.databaseUnreachable) return;
    ctx.status = 503;
    ctx.type = 'json';
    ctx.body = { error: 'temporarily_unavailable', error_description: 'The service is temporarily unavailable' };
  });
  return provider;
}

const cache = globalThis as { jawMcpProvider?: Provider };

export function provider(): Provider {
  cache.jawMcpProvider ??= createProvider(config());
  return cache.jawMcpProvider;
}

export async function oauth(req: Request): Promise<Response> {
  return bridge(req, provider().callback());
}
