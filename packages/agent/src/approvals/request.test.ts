import { hashMessage } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  atTime,
  decide,
  openRequest,
  parseApprovalId,
  payloadHash,
  previewHash,
  previewOf,
  rejectionMessage,
  signedPayload,
  toPageView,
  validateMessage,
  grantMatches,
  type ApprovalId,
  type ApprovalRequest,
  type DecisionEvidence,
  type Preview,
} from './request.js';
import type { GrantedPermission } from '../session/session-config.js';

const T0 = new Date('2026-10-06T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const ACCOUNT = '0x6ca4000000000000000000000000000000006769';
const ID = 'q3L0x7mJ2c1VfN8aYw4p9A' as ApprovalId;
const SESSION = '0x5e55000000000000000000000000000000005e55';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const request = (message = 'Sign in to example.com\nNonce: 8f2c'): ApprovalRequest =>
  openRequest(
    {
      id: ID,
      account: ACCOUNT,
      chainId: 84532,
      requester: { name: 'Example Agent', clientId: 'https://agent.example/client.json' },
      sessionAddress: SESSION,
      body: { kind: 'signature', message },
    },
    T0
  );

const evidence = (at = later(1000)): DecisionEvidence => ({
  previewHash: '0x01',
  payloadHash: '0x02',
  proof: { type: 'signature', signature: '0x03', assertionRef: '0x04' },
  decidedAt: at,
});

describe('approval request state machine', () => {
  it('opens pending and expires ten minutes later', () => {
    const r = request();
    expect(r.state).toEqual({ status: 'pending' });
    expect(r.expiresAt.getTime() - r.createdAt.getTime()).toBe(APPROVAL_TTL_MS);
  });

  it('moves pending to approved with the evidence', () => {
    const result = decide(request(), 'approved', evidence(), later(1000));
    expect(result).toMatchObject({ ok: true, request: { state: { status: 'approved', evidence: evidence() } } });
  });

  it('moves pending to rejected with the evidence', () => {
    const result = decide(request(), 'rejected', evidence(), later(1000));
    expect(result).toMatchObject({ ok: true, request: { state: { status: 'rejected' } } });
  });

  it('reads pending as expired from expiresAt on, and refuses a late decision', () => {
    const r = request();
    expect(atTime(r, later(APPROVAL_TTL_MS - 1)).state.status).toBe('pending');
    expect(atTime(r, later(APPROVAL_TTL_MS)).state.status).toBe('expired');
    const late = decide(r, 'approved', evidence(), later(APPROVAL_TTL_MS));
    expect(late).toMatchObject({ ok: false, refusal: 'expired', request: { state: { status: 'expired' } } });
  });

  it.each(['approved', 'rejected'] as const)('never moves out of %s, not even after expiry', (first) => {
    const decided = decide(request(), first, evidence(), later(1000));
    if (!decided.ok) throw new Error('setup');
    for (const verdict of ['approved', 'rejected'] as const) {
      for (const now of [later(2000), later(APPROVAL_TTL_MS * 2)]) {
        const again = decide(decided.request, verdict, evidence(now), now);
        expect(again).toEqual({ ok: false, refusal: 'already_decided', request: decided.request });
      }
    }
    expect(atTime(decided.request, later(APPROVAL_TTL_MS * 2)).state.status).toBe(first);
  });

  it('never moves out of expired', () => {
    const expired = atTime(request(), later(APPROVAL_TTL_MS));
    expect(decide(expired, 'approved', evidence(), later(1000))).toMatchObject({ ok: false, refusal: 'expired' });
  });
});

describe('what gets signed', () => {
  it('approve signs the stored message byte for byte; reject signs a statement naming the request', () => {
    const message = 'line one\r\n\ttabbed \u202Ereversed';
    const r = request(message);
    expect(signedPayload(r, 'approved')).toEqual({ type: 'message', message });
    expect(signedPayload(r, 'rejected')).toEqual({ type: 'message', message: `JAW approval request ${ID}: reject` });
    expect(payloadHash(signedPayload(r, 'approved'))).toBe(hashMessage(message));
  });

  it('refuses empty, oversized and reserved messages', () => {
    expect(validateMessage('')).toBe('empty');
    expect(validateMessage('x'.repeat(4097))).toBe('too_long');
    expect(validateMessage('JAW connection consent\nInteraction: x')).toBe('reserved_prefix');
    expect(validateMessage('x'.repeat(4096))).toBeUndefined();
  });

  it('parses only well-formed ids', () => {
    expect(parseApprovalId(ID)).toBe(ID);
    expect(parseApprovalId('../../etc')).toBeUndefined();
    expect(parseApprovalId(`${ID}x`)).toBeUndefined();
  });
});

describe('who asked', () => {
  it('shows a third-party client by its domain and flags a name that claims to be JAW', () => {
    const r = openRequest(
      {
        id: ID,
        account: ACCOUNT,
        chainId: 84532,
        requester: { name: 'JAW CLI', clientId: 'https://evil.example/client.json' },
        sessionAddress: SESSION,
        body: { kind: 'signature', message: 'hi' },
      },
      T0
    );
    expect(previewOf(r).requester).toEqual({
      clientId: 'https://evil.example/client.json',
      name: 'JAW CLI',
      host: 'evil.example',
      official: false,
      reservedName: true,
    });
  });
});

function textOf(preview: Preview) {
  if (preview.kind !== 'signature') throw new Error('not a signature preview');
  return preview;
}

describe('preview of a hostile message', () => {
  const hostile = [
    '<img src=x onerror=alert(1)><script>steal()</script>',
    'Send to: 0x2222222222222222222222222222222222222222',
    'Amount: 1 USDC\u202E0001\u202C',
    'zero\u200Bwidth and bell\u0007, soft\u00ADhyphen and tag\u{E0041}',
  ].join('\n');

  it('shows hidden characters as code points and flags markup and address lines', () => {
    const preview = textOf(previewOf(request(hostile)));
    expect(preview.text).toContain('Amount: 1 USDC⟦U+202E⟧0001⟦U+202C⟧');
    expect(preview.text).toContain('zero⟦U+200B⟧width and bell⟦U+0007⟧, soft⟦U+00AD⟧hyphen and tag⟦U+E0041⟧');
    expect(preview.text).toContain('<img src=x onerror=alert(1)>');
    expect(preview.text.split('\n')).toHaveLength(4);
    expect(preview.warnings).toEqual(['hidden_characters', 'address_like', 'markup_like']);
  });

  it('shows variation selectors and the combining grapheme joiner', () => {
    const preview = textOf(previewOf(request('a\uFE0Fb\u034Fc\u{E0100}d\u180Be')));
    expect(preview.text).toBe('a⟦U+FE0F⟧b⟦U+034F⟧c⟦U+E0100⟧d⟦U+180B⟧e');
    expect(preview.warnings).toContain('hidden_characters');
  });

  it('leaves the signed payload untouched by the preview', () => {
    const r = request(hostile);
    expect(toPageView(r).approve).toEqual({ type: 'message', message: hostile });
  });

  it('hashes the preview stably and changes the hash when the text changes', () => {
    const a = toPageView(request(hostile));
    expect(a.previewHash).toBe(previewHash(previewOf(request(hostile))));
    expect(toPageView(request(`${hostile}!`)).previewHash).not.toBe(a.previewHash);
    expect(a.previewHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('budget', () => {
  const EXPIRY = 1_790_000_000;
  const budget = (spender = SESSION): ApprovalRequest =>
    openRequest(
      {
        id: ID,
        account: ACCOUNT,
        chainId: 84532,
        requester: { name: 'Example Agent', clientId: 'https://agent.example/client.json' },
        sessionAddress: SESSION,
        body: { kind: 'budget', spender, token: USDC, allowance: '1000000', expiry: EXPIRY },
      },
      T0
    );
  const granted = (over: Partial<GrantedPermission> = {}): GrantedPermission => ({
    account: ACCOUNT,
    spender: SESSION,
    start: 1_780_000_000,
    end: EXPIRY,
    salt: '0x1234',
    calls: [{ target: USDC, selector: '0xa9059cbb' }],
    spends: [{ token: USDC, allowance: '1000000', unit: 'day', multiplier: 1 }],
    ...over,
  });

  it('previews the daily allowance, the token and the session key as spender', () => {
    expect(previewOf(budget())).toMatchObject({
      kind: 'budget',
      account: ACCOUNT,
      spender: SESSION,
      token: USDC,
      allowance: '1000000',
      period: 'day',
      expiresAt: new Date(EXPIRY * 1000).toISOString(),
    });
  });

  it('throws on a budget whose spender is not the connection session key', () => {
    const other = budget('0x0000000000000000000000000000000000000bad');
    expect(() => previewOf(other)).toThrow(/session key/);
    expect(() => signedPayload(other, 'approved')).toThrow(/session key/);
  });

  it('approves by executing a grant of USDC transfers only, capped per day, to the session key', () => {
    expect(signedPayload(budget(), 'approved')).toEqual({
      type: 'grant',
      grant: {
        address: ACCOUNT,
        spender: SESSION,
        expiry: EXPIRY,
        chainId: '0x14a34',
        permissions: {
          calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
          spends: [{ token: USDC, allowance: '1000000', unit: 'day', multiplier: 1 }],
        },
        capabilities: { prefundSpender: true },
      },
    });
    expect(signedPayload(budget(), 'rejected')).toEqual({ type: 'message', message: rejectionMessage(ID) });
  });

  it('hashes the grant payload stably', () => {
    const payload = signedPayload(budget(), 'approved');
    expect(payloadHash(payload)).toBe(payloadHash(signedPayload(budget(), 'approved')));
    expect(payloadHash(payload)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('accepts only the exact permission the grant asked for', () => {
    const payload = signedPayload(budget(), 'approved');
    if (payload.type !== 'grant') throw new Error('setup');
    expect(grantMatches(payload.grant, granted())).toBe(true);
    expect(grantMatches(payload.grant, granted({ spender: ACCOUNT }))).toBe(false);
    expect(grantMatches(payload.grant, granted({ end: EXPIRY + 1 }))).toBe(false);
    expect(grantMatches(payload.grant, granted({ calls: [{ target: USDC, selector: '0x095ea7b3' }] }))).toBe(false);
    expect(
      grantMatches(
        payload.grant,
        granted({ spends: [{ token: USDC, allowance: '1000001', unit: 'day', multiplier: 1 }] })
      )
    ).toBe(false);
    expect(
      grantMatches(
        payload.grant,
        granted({ spends: [{ token: USDC, allowance: '1000000', unit: 'week', multiplier: 1 }] })
      )
    ).toBe(false);
  });
});
