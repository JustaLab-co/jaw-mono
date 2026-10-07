import { createHash, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { sanitizeLine } from '@jaw.id/agent';
import { isAddress, isHex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { verifyOnChain, type VerifySignature } from '@/lib/chain';
import { pageCors } from '@/lib/cors';
import { bridge } from './bridge';
import { config } from './config';
import { OFFICIAL_CLIENTS, provider, SCOPES, type Scope } from './provider';
import { activate, findClaimable, insertPending } from './rows';
import { seal } from './seal';

const UID = /^[A-Za-z0-9_-]{10,64}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ConsentDetails {
  uid: string;
  client: { id: string; name: string; host: string | null; official: boolean };
  redirectHost: string;
  scopes: { id: Scope; label: string }[];
  chainId: number;
  expiresAt: string;
  message: string;
}

export function consentMessage(d: Omit<ConsentDetails, 'message'>, issuerHost: string): string {
  return [
    'JAW connection consent',
    `${issuerHost} asks to connect an app to your JAW account.`,
    '',
    `App: ${d.client.name}`,
    `Client ID: ${d.client.id}`,
    `Scopes: ${d.scopes.map((s) => s.id).join(' ') || 'none'}`,
    `Chain ID: ${d.chainId}`,
    `Interaction: ${d.uid}`,
    `Expires: ${d.expiresAt}`,
  ].join('\n');
}

async function loadDetails(uid: string): Promise<ConsentDetails | undefined> {
  if (!UID.test(uid)) return undefined;
  const p = provider();
  const interaction = await p.Interaction.find(uid);
  if (!interaction || interaction.exp * 1000 <= Date.now()) return undefined;
  const params = interaction.params as Record<string, string | undefined>;
  const client = params.client_id ? await p.Client.find(params.client_id) : undefined;
  if (!client || !params.redirect_uri) return undefined;
  const requested = (params.scope ?? '').split(' ').filter((s): s is Scope => s in SCOPES);
  const { chain, issuer } = config();
  const details: Omit<ConsentDetails, 'message'> = {
    uid,
    client: {
      id: client.clientId,
      name: sanitizeLine(client.clientName ?? client.clientId, 64),
      host: URL.canParse(client.clientId) ? new URL(client.clientId).host : null,
      official: OFFICIAL_CLIENTS.has(client.clientId),
    },
    redirectHost: new URL(params.redirect_uri).hostname,
    scopes: requested.map((id) => ({ id, label: SCOPES[id] })),
    chainId: chain.id,
    expiresAt: new Date(interaction.exp * 1000).toISOString(),
  };
  return { ...details, message: consentMessage(details, new URL(issuer).host) };
}

const uidOf = (req: Request) => new URL(req.url).pathname.split('/')[2];

// The provider scopes the interaction cookie to this path, so the browser
// passes through here on its way to keys.jaw.id and comes back under it.
export function hop(req: Request): Response {
  const uid = uidOf(req);
  if (!UID.test(uid)) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.redirect(`${config().keysOrigin}/authorize?uid=${uid}`, 303);
}

export async function details(req: Request): Promise<Response> {
  const found = await loadDetails(uidOf(req));
  return pageCors(found ? Response.json(found) : Response.json({ error: 'not_found' }, { status: 404 }));
}

// Completion needs both the one-time ticket (this browser signed) and the
// interaction cookie (this browser started), which defeats a phished consent link.
export async function consent(req: Request, verify: VerifySignature = verifyOnChain): Promise<Response> {
  const uid = uidOf(req);
  const body = (await req.json().catch(() => ({}))) as { address?: string; signature?: string };
  if (!body.address || !isAddress(body.address) || !body.signature || !isHex(body.signature)) {
    return pageCors(Response.json({ error: 'invalid_request' }, { status: 400 }));
  }
  const found = await loadDetails(uid);
  if (!found) return pageCors(Response.json({ error: 'not_found' }, { status: 404 }));
  const valid = await verify({ address: body.address, message: found.message, signature: body.signature }).catch(
    () => false
  );
  if (!valid) return pageCors(Response.json({ error: 'bad_signature' }, { status: 401 }));

  const id = `conn_${randomBytes(16).toString('base64url')}`;
  const privateKey = generatePrivateKey();
  const ticket = randomBytes(32).toString('base64url');
  const inserted = await insertPending(
    {
      id,
      account: body.address,
      chainId: found.chainId,
      clientId: found.client.id,
      clientName: found.client.name,
      scopes: found.scopes.map((s) => s.id),
      sessionAddress: privateKeyToAddress(privateKey),
      sealedKey: seal(config().ring, privateKey, id),
      interactionUid: uid,
      expiresAt: new Date(found.expiresAt),
    },
    sha256(ticket)
  );
  if (!inserted) return pageCors(Response.json({ error: 'already_consented' }, { status: 409 }));
  return pageCors(Response.json({ next: `${config().issuer}/interaction/${uid}/complete?ticket=${ticket}` }));
}

function fail(res: ServerResponse, status: number, error: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error }));
}

export function complete(req: Request): Promise<Response> {
  const uid = uidOf(req);
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
    await p.interactionFinished(
      nodeReq,
      nodeRes,
      { login: { accountId: row.id, remember: false }, consent: { grantId } },
      { mergeWithLastSubmission: false }
    );
  });
}

export function abort(req: Request): Promise<Response> {
  const p = provider();
  return bridge(req, async (nodeReq, nodeRes) => {
    const interaction = await p.interactionDetails(nodeReq, nodeRes).catch(() => undefined);
    if (!interaction || interaction.uid !== uidOf(req)) return fail(nodeRes, 400, 'interaction_mismatch');
    await p.interactionFinished(
      nodeReq,
      nodeRes,
      { error: 'access_denied', error_description: 'The user declined the connection' },
      { mergeWithLastSubmission: false }
    );
  });
}
