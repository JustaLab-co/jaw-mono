import { decide, payloadHash, signedPayload, toPageView, type ApprovalPageView, type Verdict } from '@jaw.id/agent';
import { isHex, keccak256, type Hex } from 'viem';
import { SUPPORTED_CHAINS } from '@/connections/config';
import { verifyOnChain, type VerifySignature } from '@/lib/chain';
import { log } from '@/lib/edge';
import { connectionLive, findById, recordDecision } from './store';

export type PageOutcome =
  | { kind: 'ok'; view: ApprovalPageView }
  | { kind: 'not_found' }
  | { kind: 'invalid_request' }
  | { kind: 'bad_signature' }
  | { kind: 'connection_revoked' }
  | { kind: 'unsupported_chain' }
  | { kind: 'verification_unavailable' }
  | { kind: 'preview_changed' }
  | { kind: 'not_pending'; view: ApprovalPageView };

export async function readForPage(id: string, now = new Date()): Promise<PageOutcome> {
  const request = await findById(id, now);
  return request ? { kind: 'ok', view: toPageView(request) } : { kind: 'not_found' };
}

// The page never posts the payload: the signature is checked against the one
// derived from the stored row, so a page that signed anything else is refused.
export async function decideFromPage(
  id: string,
  post: unknown,
  verify: VerifySignature = verifyOnChain,
  now = new Date()
): Promise<PageOutcome> {
  const { verdict, signature, previewHash } = (post ?? {}) as Record<string, unknown>;
  if ((verdict !== 'approved' && verdict !== 'rejected') || !isHex(signature) || !isHex(previewHash)) {
    return { kind: 'invalid_request' };
  }
  const request = await findById(id, now);
  if (!request) return { kind: 'not_found' };
  const view = toPageView(request);
  if (request.state.status !== 'pending') return { kind: 'not_pending', view };
  if (view.previewHash !== previewHash) return { kind: 'preview_changed' };
  if (!(await connectionLive(request.id))) return { kind: 'connection_revoked' };
  if (!SUPPORTED_CHAINS[request.chainId]) return { kind: 'unsupported_chain' };

  const payload = signedPayload(request, verdict as Verdict);
  const valid = await verify({
    chainId: request.chainId,
    address: request.account,
    message: payload.message,
    signature,
  }).catch((err: unknown) => {
    log('error', { msg: 'approval verification unavailable', error: err instanceof Error ? err.name : 'unknown' });
    return undefined;
  });
  if (valid === undefined) return { kind: 'verification_unavailable' };
  if (!valid) return { kind: 'bad_signature' };

  const evidence = {
    previewHash: previewHash as Hex,
    payloadHash: payloadHash(payload),
    signature,
    assertionRef: keccak256(signature),
    decidedAt: now,
  };
  const result = decide(request, verdict as Verdict, evidence, now);
  if (!result.ok || !(await recordDecision(result.request))) {
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
