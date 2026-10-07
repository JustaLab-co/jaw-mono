import type { AuthInfo } from '@modelcontextprotocol/server';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import { withMcpAuth } from 'mcp-handler';
import type { Address, Hex } from 'viem';
import { ipKey } from '@/lib/edge';
import { config } from './config';
import type { Scope } from './provider';
import { findActive } from './rows';
import { open, type Sealed } from './seal';

export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

export interface Tenant {
  connectionId: string;
  account: Address;
  chainId: number;
  clientId: string;
  clientName: string;
  scopes: Scope[];
  sessionAddress: Address;
  sessionKey(): Hex;
}

interface Claims {
  jti: string;
  sub: string;
  client_id: string;
  scope?: string;
  aud: string | string[];
  iss: string;
  /** The session key, sealed: the only copy the server can open without the refresh token. */
  sk: Sealed;
  exp: number;
}

async function decrypt(bearer: string, expired = false): Promise<Claims | undefined> {
  const { issuer, resource, ring } = config();
  let claims: Claims;
  try {
    const key = ring.keys.find((k) => k.kid === decodeProtectedHeader(bearer).kid);
    if (!key) return undefined;
    claims = JSON.parse(new TextDecoder().decode((await compactDecrypt(bearer, key.jwe)).plaintext));
  } catch {
    return undefined;
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(resource)) return undefined;
  if (!expired && claims.exp * 1000 <= Date.now()) return undefined;
  return claims;
}

const bearerOf = (req: Request) => req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];

/** The connection a bearer token names, from decryption alone: a rate limit key with no database read. */
export async function connectionKey(req: Request): Promise<string | undefined> {
  const bearer = bearerOf(req);
  const claims = bearer ? await decrypt(bearer) : undefined;
  return claims ? `conn:${claims.sub}` : ipKey(req);
}

export async function clientOf(req: Request): Promise<string> {
  const bearer = bearerOf(req);
  return (bearer && (await decrypt(bearer, true))?.client_id) || 'unknown';
}

export async function verifyBearer(bearer: string | undefined): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const claims = await decrypt(bearer);
  if (!claims) return undefined;
  const row = await findActive(claims.sub);
  if (!row?.sessionAddress || row.clientId !== claims.client_id) return undefined;
  const tenant: Tenant = {
    connectionId: row.id,
    account: row.account as Address,
    chainId: row.chainId,
    clientId: row.clientId,
    clientName: row.clientName,
    scopes: row.scopes as Scope[],
    sessionAddress: row.sessionAddress as Address,
    sessionKey: () => open(config().ring, claims.sk, row.id),
  };
  return {
    token: claims.jti,
    clientId: claims.client_id,
    scopes: (claims.scope ?? '').split(' ').filter(Boolean),
    expiresAt: claims.exp,
    resource: new URL(config().resource),
    extra: { tenant },
  };
}

export function withConnection(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return (req) =>
    withMcpAuth(handler, (_req, bearer) => verifyBearer(bearer), {
      required: true,
      requiredScopes: ['wallet:read'],
      resourceMetadataPath: RESOURCE_METADATA_PATH,
      resourceUrl: config().issuer,
    })(req);
}

export function tenant(ctx: { http?: { authInfo?: AuthInfo } }): Tenant {
  const found = ctx.http?.authInfo?.extra?.tenant as Tenant | undefined;
  if (!found) throw new Error('tool called without a verified connection');
  return found;
}
