import {
  decide,
  grantMatches,
  parseGrantedPermission,
  payloadHash,
  readPermissionState,
  signedPayload,
  toPageView,
  type ApprovalPageView,
  type ApprovalRequest,
  type DecisionProof,
  type GrantRequest,
  type PermissionReadTarget,
  type PermissionState,
} from '@jaw.id/agent';
import { isHex, keccak256, type Address, type Hex } from 'viem';
import { SUPPORTED_CHAINS } from '@/connections/config';
import { publicClientFor, verifyOnChain, type VerifySignature } from '@/lib/chain';
import { log } from '@/lib/edge';
import { currentGrant } from '@/grants/store';
import { connectionLive, connectionOf, findById, recordDecision, type NewGrant } from './store';

export type PageOutcome =
  | { kind: 'ok'; view: ApprovalPageView & { replaces?: { permissionId: Hex } } }
  | { kind: 'not_found' }
  | { kind: 'invalid_request' }
  | { kind: 'bad_signature' }
  | { kind: 'grant_mismatch' }
  | { kind: 'grant_not_found' }
  | { kind: 'connection_revoked' }
  | { kind: 'unsupported_chain' }
  | { kind: 'verification_unavailable' }
  | { kind: 'preview_changed' }
  | { kind: 'not_pending'; view: ApprovalPageView };

export type ReadPermission = (target: PermissionReadTarget) => Promise<PermissionState>;

const readOnChain: ReadPermission = (target) =>
  readPermissionState(target, { clients: { publicClient: publicClientFor } });

type Refused = Exclude<PageOutcome['kind'], 'ok' | 'not_pending'>;
type Checked = { proof: DecisionProof; grant?: NewGrant } | { refused: Refused };

const unavailable = (what: string) => (err: unknown) => {
  log('error', { msg: `${what} unavailable`, error: err instanceof Error ? err.name : 'unknown' });
  return undefined;
};

async function checkSignature(
  request: ApprovalRequest,
  payload: Parameters<VerifySignature>[0]['payload'],
  signature: unknown,
  verify: VerifySignature
): Promise<Checked> {
  if (!isHex(signature)) return { refused: 'invalid_request' };
  const valid = await verify({ chainId: request.chainId, address: request.account, payload, signature }).catch(
    unavailable('approval verification')
  );
  if (valid === undefined) return { refused: 'verification_unavailable' };
  if (!valid) return { refused: 'bad_signature' };
  return { proof: { type: 'signature', signature, assertionRef: keccak256(signature) } };
}

async function checkPermission(
  request: ApprovalRequest,
  grant: GrantRequest,
  granted: unknown,
  read: ReadPermission
): Promise<Checked> {
  const permission = parseGrantedPermission(granted);
  const permissionId = (granted as { permissionId?: unknown } | null)?.permissionId;
  if (!permission || !isHex(permissionId)) return { refused: 'invalid_request' };
  if (!grantMatches(grant, permission)) return { refused: 'grant_mismatch' };
  const state = await read({ chainId: request.chainId, permissionId, permission }).catch(
    unavailable('permission read')
  );
  if (!state || state.status === 'unavailable') return { refused: 'verification_unavailable' };
  if (state.status === 'mismatch') return { refused: 'grant_mismatch' };
  if (!state.approved || state.revoked) return { refused: 'grant_not_found' };
  const [spend] = grant.permissions.spends;
  return {
    proof: { type: 'permission', permissionId },
    grant: {
      permissionId,
      chainId: request.chainId,
      account: grant.address,
      spender: grant.spender as Address,
      token: spend.token,
      allowance: spend.allowance,
      period: spend.unit,
      permission,
      expiresAt: new Date(permission.end * 1000),
    },
  };
}

export async function readForPage(id: string, now = new Date()): Promise<PageOutcome> {
  const request = await findById(id, now);
  if (!request) return { kind: 'not_found' };
  const view = toPageView(request);
  if (request.body.kind !== 'budget' || request.state.status !== 'pending') return { kind: 'ok', view };
  // The budget this one replaces, which the page revokes right after granting the new one.
  const previous = await currentGrant(await connectionOf(request.id));
  return { kind: 'ok', view: previous ? { ...view, replaces: { permissionId: previous.permissionId } } : view };
}

export async function decideFromPage(
  id: string,
  post: unknown,
  verify: VerifySignature = verifyOnChain,
  now = new Date(),
  readPermission: ReadPermission = readOnChain
): Promise<PageOutcome> {
  const { verdict, signature, previewHash, permission } = (post ?? {}) as Record<string, unknown>;
  if ((verdict !== 'approved' && verdict !== 'rejected') || !isHex(previewHash)) {
    return { kind: 'invalid_request' };
  }
  const request = await findById(id, now);
  if (!request) return { kind: 'not_found' };
  const view = toPageView(request);
  if (request.state.status !== 'pending') return { kind: 'not_pending', view };
  if (view.previewHash !== previewHash) return { kind: 'preview_changed' };
  if (!(await connectionLive(request.id))) return { kind: 'connection_revoked' };
  if (!SUPPORTED_CHAINS[request.chainId]) return { kind: 'unsupported_chain' };

  const payload = signedPayload(request, verdict);
  const checked =
    payload.type === 'grant'
      ? await checkPermission(request, payload.grant, permission, readPermission)
      : await checkSignature(request, payload, signature, verify);
  if ('refused' in checked) return { kind: checked.refused };

  const evidence = { previewHash, payloadHash: payloadHash(payload), proof: checked.proof, decidedAt: now };
  const result = decide(request, verdict, evidence, now);
  if (!result.ok || !(await recordDecision(result.request, checked.grant))) {
    if (!(await connectionLive(request.id))) return { kind: 'connection_revoked' };
    const current = await findById(id, new Date());
    return current ? { kind: 'not_pending', view: toPageView(current) } : { kind: 'not_found' };
  }
  return { kind: 'ok', view: toPageView(result.request) };
}

const STATUS: Record<PageOutcome['kind'], number> = {
  ok: 200,
  not_found: 404,
  invalid_request: 400,
  bad_signature: 403,
  grant_mismatch: 422,
  grant_not_found: 409,
  connection_revoked: 410,
  unsupported_chain: 422,
  verification_unavailable: 503,
  preview_changed: 409,
  not_pending: 409,
};

export function outcomeResponse(outcome: PageOutcome): Response {
  const body = 'view' in outcome ? { ...outcome.view, outcome: outcome.kind } : { error: outcome.kind };
  return Response.json(body, { status: STATUS[outcome.kind] });
}
