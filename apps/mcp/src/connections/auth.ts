import type { AuthInfo } from '@modelcontextprotocol/server';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import { withMcpAuth } from 'mcp-handler';
import type { Address } from 'viem';
import { config } from './config';
import type { Scope } from './provider';
import { findActive } from './rows';

export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

/** What a tool may know about its caller. Built only from a verified token and a live connection row. */
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

/** undefined for anything that is not a live token for this resource; never throws, never logs the token. */
export async function verifyBearer(bearer: string | undefined): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
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
  const row = await findActive(claims.sub);
  if (!row || row.clientId !== claims.client_id) return undefined;
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
    resource: new URL(resource),
    extra: { tenant },
  };
}

/** The MCP route behind OAuth: 401 with resource_metadata without a live token, 403 without wallet:read. */
export function withConnection(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return (req) =>
    withMcpAuth(handler, (_req, bearer) => verifyBearer(bearer), {
      required: true,
      requiredScopes: ['wallet:read'],
      resourceMetadataPath: RESOURCE_METADATA_PATH,
      resourceUrl: config().issuer,
    })(req);
}

/** The caller of a tool. Throws only when a tool is reachable without withConnection, a wiring bug. */
export function tenant(ctx: { http?: { authInfo?: AuthInfo } }): Tenant {
  const found = ctx.http?.authInfo?.extra?.tenant as Tenant | undefined;
  if (!found) throw new Error('tool called without a verified connection');
  return found;
}
