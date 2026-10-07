import type { AuthInfo } from '@modelcontextprotocol/server';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import { withMcpAuth } from 'mcp-handler';
import type { Address } from 'viem';
import { ipKey } from '@/lib/edge';
import { config } from './config';
import type { Scope } from './provider';
import { findActive } from './rows';

export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

export interface Tenant {
  connectionId: string;
  account: Address;
  chainId: number;
  clientId: string;
  clientName: string;
  scopes: Scope[];
  sessionAddress: Address;
}

interface Claims {
  jti: string;
  sub: string;
  client_id: string;
  scope?: string;
  aud: string | string[];
  iss: string;
  exp: number;
}

/** Claims of a token this server issued for this resource and that has not expired. */
async function decrypt(bearer: string): Promise<Claims | undefined> {
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
  if (claims.iss !== issuer || !audiences.includes(resource) || claims.exp * 1000 <= Date.now()) return undefined;
  return claims;
}

/** The connection a bearer token names, from decryption alone: a rate limit key with no database read. */
export async function connectionKey(req: Request): Promise<string | undefined> {
  const bearer = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  const claims = bearer ? await decrypt(bearer) : undefined;
  return claims ? `conn:${claims.sub}` : ipKey(req);
}

export async function verifyBearer(bearer: string | undefined): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const claims = await decrypt(bearer);
  if (!claims || !(claims.scope ?? '').split(' ').includes('wallet:read')) return undefined;
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
      // No required scope: the challenge would name it, and an MCP client then
      // asks for that scope alone instead of every scope the metadata lists.
      required: true,
      resourceMetadataPath: RESOURCE_METADATA_PATH,
      resourceUrl: config().issuer,
    })(req);
}

export function tenant(ctx: { http?: { authInfo?: AuthInfo } }): Tenant {
  const found = ctx.http?.authInfo?.extra?.tenant as Tenant | undefined;
  if (!found) throw new Error('tool called without a verified connection');
  return found;
}
