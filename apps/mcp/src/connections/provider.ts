import { CONNECTION_SCOPES, FIRST_PARTY_CLIENTS, hasUnstorableText } from '@jaw.id/agent';
import Provider, { errors, interactionPolicy, type Configuration } from 'oidc-provider';
import { databaseUnreachable, log } from '@/lib/edge';
import { resolvesPublic } from '@/lib/safe-fetch';
import { PgAdapter, sessionKey, successorId } from './adapter';
import { bridge, requestUrl } from './bridge';
import { config, type Config } from './config';
import { findActive } from './rows';
import { seal } from './seal';

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
    adapter: (model: string) => new PgAdapter(model, cfg.ring),
    clients: [JAW_CLI],
    clientDefaults: { id_token_signed_response_alg: 'EdDSA' },
    findAccount: async (_ctx, sub) =>
      (await findActive(sub)) ? { accountId: sub, claims: () => ({ sub }) } : undefined,
    pkce: { required: () => true },
    fetchResponseBodyLimits: {
      'client_id metadata document': 5 * 1024,
      jwks_uri: 64 * 1024,
      sector_identifier_uri: 64 * 1024,
    },
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
      pushedAuthorizationRequests: { enabled: false },
      userinfo: { enabled: false },
      revocation: { enabled: true },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        // The provider cuts a private socket only after connecting; the delay would tell whether the host is live.
        allowFetch: (_ctx, clientId) => resolvesPublic(new URL(clientId).hostname),
        // Public clients only: a jwks_uri would be fetched for every request it signs.
        allowClient: async (_ctx, client) =>
          client.tokenEndpointAuthMethod === 'none' && !client.jwksUri && !hasUnstorableText(client.clientName ?? ''),
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => cfg.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (ctx, indicator) => {
          if (indicator !== cfg.resource) throw new errors.InvalidTarget();
          // Every tool needs wallet:read. Refused here, the provider answers the
          // client with an OAuth error instead of leaving the user on a dead page.
          const scope = String(ctx.oidc.params?.scope ?? '').split(' ');
          if (ctx.oidc.route === 'authorization' && !scope.includes('wallet:read')) {
            throw new errors.InvalidScope('wallet:read is required', 'wallet:read');
          }
          return {
            scope: Object.keys(CONNECTION_SCOPES).join(' '),
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
      token.kind === 'AccessToken'
        ? { sk: seal(cfg.ring, await sessionKey(token.accountId), token.accountId) }
        : undefined,
    ...overrides,
  });
  provider.proxy = true;
  // Not a documented option: oidc-provider is pinned, and the retry tests fail if it stops calling this.
  const token = provider.RefreshToken.prototype as unknown as { generateTokenId(): string };
  const random = token.generateTokenId;
  token.generateTokenId = function () {
    return successorId() ?? random.call(this);
  };
  provider.on('server_error', (ctx: { state: Record<string, unknown> }, err: Error) => {
    if (databaseUnreachable(err)) ctx.state.databaseUnreachable = true;
    log('error', { msg: 'oauth server error', error: err.name });
  });
  // The provider renders its own 500 for errors in its routes; a database
  // outage should read as one, like everywhere else on this server.
  // The wallet scopes are resource scopes, so the provider leaves them out of
  // its metadata; MCP clients ask for the scopes the metadata lists.
  provider.use(async (ctx, next) => {
    await next();
    const body = ctx.body as { scopes_supported?: string[] } | undefined;
    if (ctx.oidc?.route === 'discovery' && body?.scopes_supported) {
      body.scopes_supported = [...body.scopes_supported, ...Object.keys(CONNECTION_SCOPES)];
    }
  });
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

// A client that asks for no wallet scope (none at all, or only openid
// offline_access) gets wallet:read, the scope every tool needs.
function withDefaultScope(req: Request): Request {
  const url = new URL(requestUrl(req));
  if (req.method !== 'GET' || url.pathname !== '/oauth/authorize') return req;
  const scope = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
  // `in` would also count prototype keys such as constructor.
  if (scope.some((s) => Object.hasOwn(CONNECTION_SCOPES, s))) return req;
  url.searchParams.set('scope', [...scope, 'wallet:read'].join(' '));
  return new Request(url, req);
}

export async function oauth(req: Request): Promise<Response> {
  return bridge(withDefaultScope(req), provider().callback());
}
