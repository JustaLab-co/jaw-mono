import { createHash, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { clientIdentity, consentTypedData, type ClientIdentity } from '@jaw.id/agent';
import { isAddress, isHex } from 'viem';
import { readJson, tooLarge } from '@/lib/body';
import { verifyOnChain, type VerifySignature } from '@/lib/chain';
import { log } from '@/lib/edge';
import { bridge } from './bridge';
import { config } from './config';
import { provider, SCOPES, type Scope } from './provider';
import { activate, findClaimable, insertPending } from './rows';

const UID = /^[A-Za-z0-9_-]{10,64}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ConsentDetails {
  uid: string;
  client: ClientIdentity;
  redirectHost: string;
  scopes: { id: Scope; label: string }[];
  chainId: number;
  expiresAt: string;
  typedData: ReturnType<typeof consentTypedData>;
}

async function loadDetails(uid: string): Promise<ConsentDetails | undefined> {
  if (!UID.test(uid)) return undefined;
  const p = provider();
  const interaction = await p.Interaction.find(uid);
  if (!interaction || interaction.exp * 1000 <= Date.now()) return undefined;
  const params = interaction.params as Record<string, string | undefined>;
  const client = params.client_id ? await p.Client.find(params.client_id) : undefined;
  if (!client || !params.redirect_uri) return undefined;
  const asked = (params.scope ?? '').split(' ');
  const requested = (Object.keys(SCOPES) as Scope[]).filter((s) => asked.includes(s));
  const { chain, issuer } = config();
  const identity = clientIdentity(client.clientId, client.clientName ?? client.clientId);
  const expiresAt = new Date(interaction.exp * 1000).toISOString();
  return {
    uid,
    client: identity,
    redirectHost: new URL(params.redirect_uri).hostname,
    scopes: requested.map((id) => ({ id, label: SCOPES[id] })),
    chainId: chain.id,
    expiresAt,
    typedData: consentTypedData(chain.id, {
      issuer,
      interaction: uid,
      clientId: identity.clientId,
      clientName: identity.name,
      scopes: requested.join(' '),
      expires: expiresAt,
    }),
  };
}

// The provider scopes the interaction cookie to this path, so the browser
// passes through here on its way to keys.jaw.id and comes back under it.
export function hop(_req: Request, uid: string): Response {
  if (!UID.test(uid)) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.redirect(`${config().keysOrigin}/authorize?uid=${uid}`, 303);
}

// Every tool needs wallet:read, so a connection without it could do nothing.
const lacksRead = (d: ConsentDetails) => !d.scopes.some((s) => s.id === 'wallet:read');
const invalidScope = () => Response.json({ error: 'invalid_scope' }, { status: 400 });

export async function details(_req: Request, uid: string): Promise<Response> {
  const found = await loadDetails(uid);
  if (!found) return Response.json({ error: 'not_found' }, { status: 404 });
  return lacksRead(found) ? invalidScope() : Response.json(found);
}

// Completion needs both the one-time ticket (this browser signed) and the
// interaction cookie (this browser started), which defeats a phished consent link.
export async function consent(req: Request, uid: string, verify: VerifySignature = verifyOnChain): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed === undefined) return tooLarge();
  const body = parsed as { address?: string; signature?: string };
  if (!body.address || !isAddress(body.address) || !body.signature || !isHex(body.signature)) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const found = await loadDetails(uid);
  if (!found) return Response.json({ error: 'not_found' }, { status: 404 });
  if (lacksRead(found)) return invalidScope();
  const valid = await verify({
    chainId: found.chainId,
    address: body.address,
    payload: { type: 'typed_data', typedData: found.typedData },
    signature: body.signature,
  }).catch((err: unknown) => {
    log('error', { msg: 'consent verification unavailable', error: err instanceof Error ? err.name : 'unknown' });
    return undefined;
  });
  if (valid === undefined) return Response.json({ error: 'verification_unavailable' }, { status: 503 });
  if (!valid) return Response.json({ error: 'bad_signature' }, { status: 401 });

  const id = `conn_${randomBytes(16).toString('base64url')}`;
  const ticket = randomBytes(32).toString('base64url');
  const inserted = await insertPending(
    {
      id,
      account: body.address,
      chainId: found.chainId,
      clientId: found.client.clientId,
      clientName: found.client.name,
      scopes: found.scopes.map((s) => s.id),
      interactionUid: uid,
      expiresAt: new Date(found.expiresAt),
    },
    sha256(ticket)
  );
  if (!inserted) return Response.json({ error: 'already_consented' }, { status: 409 });
  return Response.json({ next: `${config().issuer}/interaction/${uid}/complete?ticket=${ticket}` });
}

function fail(res: ServerResponse, status: number, error: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error }));
}

export function complete(req: Request, uid: string): Promise<Response> {
  const ticketHash = sha256(new URL(req.url).searchParams.get('ticket') ?? '');
  const p = provider();
  return bridge(req, async (nodeReq, nodeRes) => {
    const interaction = await p.interactionDetails(nodeReq, nodeRes).catch(() => undefined);
    if (!interaction || interaction.uid !== uid) return fail(nodeRes, 400, 'interaction_mismatch');
    const row = await findClaimable(uid, ticketHash);
    if (!row) return fail(nodeRes, 400, 'invalid_ticket');

    const grant = new p.Grant({ accountId: row.id, clientId: row.clientId });
    grant.addOIDCScope('openid offline_access');
    grant.addResourceScope(config().resource, row.scopes.join(' '));
    const grantId = await grant.save();
    if (!(await activate(uid, ticketHash, grantId))) {
      await grant.destroy();
      return fail(nodeRes, 400, 'invalid_ticket');
    }
    try {
      await p.interactionFinished(
        nodeReq,
        nodeRes,
        { login: { accountId: row.id, remember: false }, consent: { grantId } },
        { mergeWithLastSubmission: false }
      );
    } catch {
      // No code reached the client, so the connection must not stay usable.
      // Destroying the grant revokes the connection with it.
      await grant.destroy();
      return fail(nodeRes, 500, 'hand_back_failed');
    }
  });
}

export function abort(req: Request, uid: string): Promise<Response> {
  const p = provider();
  return bridge(req, async (nodeReq, nodeRes) => {
    const interaction = await p.interactionDetails(nodeReq, nodeRes).catch(() => undefined);
    if (!interaction || interaction.uid !== uid) return fail(nodeRes, 400, 'interaction_mismatch');
    await p.interactionFinished(
      nodeReq,
      nodeRes,
      { error: 'access_denied', error_description: 'The user declined the connection' },
      { mergeWithLastSubmission: false }
    );
  });
}
