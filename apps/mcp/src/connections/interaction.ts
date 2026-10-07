import { createHash, randomBytes } from 'node:crypto';
import { sanitizeLine } from '@jaw.id/agent';
import { createPublicClient, http, isAddress, isHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { bridge } from './bridge';
import { config } from './config';
import { OFFICIAL_CLIENTS, provider, SCOPES, type Scope } from './provider';
import { activate, findClaimable, insertPending } from './rows';
import { seal } from './seal';

export type VerifySignature = (a: { address: Address; message: string; signature: Hex }) => Promise<boolean>;

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

/** Every field comes from the stored interaction, so the server rebuilds the exact string when the signature arrives. */
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

function cors(res: Response): Response {
  res.headers.set('access-control-allow-origin', config().keysOrigin);
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set('access-control-allow-headers', 'content-type');
  res.headers.set('cache-control', 'no-store');
  res.headers.set('vary', 'origin');
  return res;
}

const verifyOnChain: VerifySignature = ({ address, message, signature }) => {
  const { chain, rpcUrl } = config();
  return createPublicClient({ chain, transport: http(rpcUrl) }).verifyMessage({ address, message, signature });
};

const uidOf = (req: Request) => new URL(req.url).pathname.split('/')[2];

/** GET /interaction/[uid]. Sends the browser on to keys.jaw.id; the interaction cookie is scoped to this path. */
export function hop(req: Request): Response {
  const uid = uidOf(req);
  if (!UID.test(uid)) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.redirect(`${config().keysOrigin}/authorize?uid=${uid}`, 303);
}

/** GET /interaction/[uid]/details. What /authorize renders, including the exact message it signs. */
export async function details(req: Request): Promise<Response> {
  const found = await loadDetails(uidOf(req));
  return cors(found ? Response.json(found) : Response.json({ error: 'not_found' }, { status: 404 }));
}

/**
 * POST /interaction/[uid]/consent { address, signature }. Verifies the consent,
 * mints the session key and hands back a one-time ticket. Completion needs both
 * the ticket (this browser signed) and the interaction cookie (this browser started).
 */
export async function consent(req: Request, verify: VerifySignature = verifyOnChain): Promise<Response> {
  const uid = uidOf(req);
  const body = (await req.json().catch(() => ({}))) as { address?: string; signature?: string };
  if (!body.address || !isAddress(body.address) || !body.signature || !isHex(body.signature)) {
    return cors(Response.json({ error: 'invalid_request' }, { status: 400 }));
  }
  const found = await loadDetails(uid);
  if (!found) return cors(Response.json({ error: 'not_found' }, { status: 404 }));
  const valid = await verify({ address: body.address, message: found.message, signature: body.signature }).catch(
    () => false
  );
  if (!valid) return cors(Response.json({ error: 'bad_signature' }, { status: 401 }));

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
  if (!inserted) return cors(Response.json({ error: 'already_consented' }, { status: 409 }));
  return cors(Response.json({ next: `${config().issuer}/interaction/${uid}/complete?ticket=${ticket}` }));
}

export function preflight(): Response {
  return cors(new Response(null, { status: 204 }));
}

function fail(res: import('node:http').ServerResponse, status: number, error: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error }));
}

/** GET /interaction/[uid]/complete?ticket=. Top-level navigation, so the interaction cookie comes along. */
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

/** GET /interaction/[uid]/abort. The user declined. */
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
