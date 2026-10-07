import { encodeFunctionData, erc20Abi, hashMessage, hashTypedData, maxUint256, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { rejectionTypedData, reservedSigningRefusal } from './reserved.js';
import type { X402PaymentRequirement } from '../x402/types.js';
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
  signedPayload,
  toPageView,
  validateMessage,
  grantMatches,
  MIN_DECISION_MS,
  openPaymentRequest,
  paymentDraft,
  stillOffered,
  type ApprovalId,
  type ApprovalRequest,
  type DecisionEvidence,
  type Preview,
  messageBody,
  typedDataRefusal,
  executedAsSigned,
  type ApprovalBody,
  type Call,
  type DescribeCall,
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

// The server's decoder lives in apps/mcp; here every call shows as raw calldata.
const rawCall: DescribeCall = (call) => ({ ...call, warnings: [{ code: 'unknown_function' }] });

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
  it('approve signs the stored message byte for byte; reject signs JAW typed data naming the request', () => {
    const message = 'line one\r\n\ttabbed \u202Ereversed';
    const r = request(message);
    expect(signedPayload(r, 'approved')).toEqual({ type: 'message', message });
    expect(signedPayload(r, 'rejected')).toEqual({ type: 'typed_data', typedData: rejectionTypedData(r.chainId, ID) });
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
    expect(previewOf(r, rawCall).requester).toEqual({
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
    const preview = textOf(previewOf(request(hostile), rawCall));
    expect(preview.text).toContain('Amount: 1 USDC⟦U+202E⟧0001⟦U+202C⟧');
    expect(preview.text).toContain('zero⟦U+200B⟧width and bell⟦U+0007⟧, soft⟦U+00AD⟧hyphen and tag⟦U+E0041⟧');
    expect(preview.text).toContain('<img src=x onerror=alert(1)>');
    expect(preview.text.split('\n')).toHaveLength(4);
    expect(preview.warnings).toEqual(['hidden_characters', 'address_like', 'markup_like']);
  });

  it('shows variation selectors and the combining grapheme joiner', () => {
    const preview = textOf(previewOf(request('a\uFE0Fb\u034Fc\u{E0100}d\u180Be'), rawCall));
    expect(preview.text).toBe('a⟦U+FE0F⟧b⟦U+034F⟧c⟦U+E0100⟧d⟦U+180B⟧e');
    expect(preview.warnings).toContain('hidden_characters');
  });

  it('leaves the signed payload untouched by the preview', () => {
    const r = request(hostile);
    expect(toPageView(r, rawCall).approve).toEqual({ type: 'message', message: hostile });
  });

  it('hashes the preview stably and changes the hash when the text changes', () => {
    const a = toPageView(request(hostile), rawCall);
    expect(a.previewHash).toBe(previewHash(previewOf(request(hostile), rawCall)));
    expect(toPageView(request(`${hostile}!`), rawCall).previewHash).not.toBe(a.previewHash);
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
    expect(previewOf(budget(), rawCall)).toMatchObject({
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
    expect(() => previewOf(other, rawCall)).toThrow(/session key/);
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
    expect(signedPayload(budget(), 'rejected')).toMatchObject({ type: 'typed_data' });
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

describe('text Postgres cannot store', () => {
  it('refuses a NUL and an unpaired surrogate, and keeps paired ones', () => {
    expect(validateMessage('a\u0000b')).toBe('unstorable');
    expect(validateMessage('a\uD800b')).toBe('unstorable');
    expect(validateMessage('a\uDC00')).toBe('unstorable');
    expect(validateMessage('gm \u{1F44B}')).toBeUndefined();
  });
});

describe('a payment approval', () => {
  const RESOURCE = 'https://seller.example/report';
  const PAY_TO = '0x2222222222222222222222222222222222222222';
  const NONCE = `0x${'11'.repeat(32)}` as const;
  const OPTION: X402PaymentRequirement = {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
  };
  const input = {
    id: ID,
    account: ACCOUNT,
    chainId: 84532,
    requester: { name: 'Example Agent', clientId: 'https://agent.example/client.json' },
    sessionAddress: SESSION,
  } as const;
  const open = (requirement = OPTION, resource = RESOURCE) =>
    openPaymentRequest(input, { resource, requirement }, T0, NONCE);
  const opened = () => {
    const r = open();
    if (!r || r.body.kind !== 'payment') throw new Error('setup');
    return { ...r, body: r.body };
  };

  it.each([0, 60, 600, 3600, undefined])(
    'relates the clocks for maxTimeoutSeconds %s: a settlement window after the last decision',
    (maxTimeoutSeconds) => {
      const r = open({ ...OPTION, maxTimeoutSeconds });
      if (!r || r.body.kind !== 'payment') throw new Error('no offer');
      const expiresAt = r.expiresAt.getTime();
      expect(Number(r.body.terms.validBefore) - expiresAt / 1000).toBeGreaterThanOrEqual(600);
      expect(expiresAt - T0.getTime()).toBeLessThanOrEqual(APPROVAL_TTL_MS);
      if (maxTimeoutSeconds) expect(expiresAt).toBeLessThanOrEqual(T0.getTime() + maxTimeoutSeconds * 1000);
    }
  );

  it('gives a 60 s challenge exactly 60 s, and offers nothing for less', () => {
    const r = open({ ...OPTION, maxTimeoutSeconds: 60 });
    expect(r?.expiresAt).toEqual(later(60_000));
    expect(r?.body).toMatchObject({ terms: { validBefore: String(T0.getTime() / 1000 + 60 + 600) } });
    expect(open({ ...OPTION, maxTimeoutSeconds: MIN_DECISION_MS / 1000 - 1 })).toBeUndefined();
  });

  it('throws on an option the signer would refuse, before anything is stored', () => {
    expect(() => open({ ...OPTION, asset: '0x0000000000000000000000000000000000000bad' })).toThrow(/asset mismatch/);
  });

  it('approves by signing TransferWithAuthorization from the account, under the USDC domain', () => {
    const r = opened();
    const approve = signedPayload(r, 'approved');
    expect(approve).toEqual({ type: 'typed_data', typedData: paymentDraft(ACCOUNT, r.body.terms).typedData });
    if (approve.type !== 'typed_data') throw new Error('setup');
    expect(approve.typedData.domain).toMatchObject({ name: 'USDC', verifyingContract: USDC, chainId: 84532 });
    expect(approve.typedData.message).toEqual({
      from: ACCOUNT,
      to: PAY_TO,
      value: '10000',
      validAfter: '0',
      validBefore: r.body.terms.validBefore,
      nonce: NONCE,
    });
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, approve.typedData])).toBeUndefined();
  });

  it('rejects under the reserved JAW domain, which every generic surface refuses', () => {
    const reject = signedPayload(opened(), 'rejected');
    expect(reject).toEqual({ type: 'typed_data', typedData: rejectionTypedData(84532, ID) });
    if (reject.type !== 'typed_data') throw new Error('setup');
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, reject.typedData])).toBeDefined();
  });

  it('previews exactly what the typed data binds, without the query', () => {
    const r = opened();
    const withQuery = open(OPTION, `${RESOURCE}?api_key=SECRET#frag`);
    const approve = signedPayload(r, 'approved');
    if (approve.type !== 'typed_data') throw new Error('setup');
    const preview = previewOf(r, rawCall);
    expect(preview).toEqual({
      kind: 'payment',
      requester: expect.objectContaining({ clientId: 'https://agent.example/client.json' }),
      account: ACCOUNT,
      chainId: 84532,
      payTo: approve.typedData.message?.to,
      token: approve.typedData.domain?.verifyingContract,
      amount: approve.typedData.message?.value,
      network: 'eip155:84532',
      resource: RESOURCE,
      warnings: [],
      validUntil: new Date(Number(r.body.terms.validBefore) * 1000).toISOString(),
    });
    expect(JSON.stringify(toPageView(withQuery as ApprovalRequest, rawCall))).not.toContain('SECRET');
  });

  it('shows the resource as the url is sent: hidden characters percent-encoded, a lookalike host in punycode', () => {
    const r = open(OPTION, 'https://sеller.example/re\u202Eport');
    expect(previewOf(r as ApprovalRequest, rawCall)).toMatchObject({
      resource: 'https://xn--sller-zwe.example/re%E2%80%AEport',
      warnings: [],
    });
  });

  describe('stillOffered', () => {
    const fresh = (...accepts: X402PaymentRequirement[]) => ({ resource: RESOURCE, accepts });
    const terms = () => opened().body.terms;

    it('finds the same option, case-insensitive on addresses, and returns the fresh copy', () => {
      const same = { ...OPTION, payTo: PAY_TO.toUpperCase().replace('0X', '0x') as `0x${string}`, extra: { a: 1 } };
      expect(stillOffered(terms(), fresh({ ...OPTION, amount: '1' }, same))).toBe(same);
    });

    it.each([
      ['a moved price', { amount: '10001' }],
      ['another recipient', { payTo: '0x3333333333333333333333333333333333333333' }],
      ['another network', { network: 'eip155:8453' }],
      ['another scheme', { scheme: 'upto' }],
    ] as const)('refuses %s', (_name, over) => {
      expect(stillOffered(terms(), fresh({ ...OPTION, ...over }))).toBeUndefined();
    });

    it('refuses the same option from another resource', () => {
      expect(stillOffered(terms(), { resource: `${RESOURCE}/v2`, accepts: [OPTION] })).toBeUndefined();
    });
  });
});

const opened = (body: ApprovalBody, account = ACCOUNT): ApprovalRequest =>
  openRequest(
    {
      id: ID,
      account,
      chainId: 84532,
      requester: { name: 'Example Agent', clientId: 'https://agent.example/client.json' },
      sessionAddress: SESSION,
      body,
    },
    T0
  );

const GAS = { estimate: '21000', context: { token: USDC, gas: '90000' } };
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const PAYMASTER = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';
const transferData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RECIPIENT, 10_000n] });

describe('a transfer', () => {
  const transfer = () =>
    opened({ kind: 'transfer', to: RECIPIENT, name: 'alice.eth', token: USDC, amount: '10000', gas: GAS });

  it('sends one USDC transfer from the account through wallet_sendCalls, and rejects under the JAW domain', () => {
    expect(signedPayload(transfer(), 'approved')).toEqual({
      type: 'calls',
      calls: [{ to: USDC, value: '0x0', data: transferData }],
      chainId: '0x14a34',
    });
    expect(signedPayload(transfer(), 'rejected')).toEqual({
      type: 'typed_data',
      typedData: rejectionTypedData(84532, ID),
    });
  });

  it('previews the name beside the address, the amount, and the gas in USDC', () => {
    expect(previewOf(transfer(), rawCall)).toMatchObject({
      kind: 'transfer',
      to: RECIPIENT,
      name: 'alice.eth',
      token: USDC,
      amount: '10000',
      gas: { token: USDC, estimate: '21000', max: '90000' },
    });
  });

  it('hands the page the paymaster context the quote was built with', () => {
    expect(toPageView(transfer(), rawCall).paymaster).toEqual({ token: USDC, gas: '90000' });
  });

  it('hashes the calls payload stably and changes the hash with the bytes', () => {
    const a = payloadHash(signedPayload(transfer(), 'approved'));
    expect(a).toBe(payloadHash(signedPayload(transfer(), 'approved')));
    const other = opened({ kind: 'transfer', to: RECIPIENT, token: USDC, amount: '10001', gas: GAS });
    expect(payloadHash(signedPayload(other, 'approved'))).not.toBe(a);
  });
});

describe('calls', () => {
  const CALLS: Call[] = [
    { to: USDC, value: '0x0', data: transferData },
    { to: RECIPIENT, value: '0x1', data: '0xdeadbeef' },
  ];
  const calls = (list = CALLS) => opened({ kind: 'calls', calls: list, gas: GAS });

  it('sends the stored calls unchanged', () => {
    expect(signedPayload(calls(), 'approved')).toEqual({ type: 'calls', calls: CALLS, chainId: '0x14a34' });
  });

  it('previews each call through the server decoder, with the gas in USDC', () => {
    const named: DescribeCall = (call) => ({ ...call, function: `seen ${call.data.slice(0, 10)}`, warnings: [] });
    expect(previewOf(calls(), named)).toMatchObject({
      kind: 'calls',
      calls: [
        { to: USDC, function: 'seen 0xa9059cbb' },
        { to: RECIPIENT, value: '0x1', data: '0xdeadbeef', function: 'seen 0xdeadbeef' },
      ],
      gas: { token: USDC, estimate: '21000', max: '90000' },
    });
  });

  it('changes the preview hash when one stored byte changes', () => {
    const swapped = [CALLS[0], { ...CALLS[1], data: '0xdeadbeee' as Hex }];
    expect(toPageView(calls(swapped), rawCall).previewHash).not.toBe(toPageView(calls(), rawCall).previewHash);
  });

  describe('what ran on chain', () => {
    const executed = (list: Call[]) => list.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }));
    const approve = (amount: bigint) => ({
      to: USDC,
      value: '0x0' as Hex,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PAYMASTER, amount] }),
    });

    it('matches the stored calls byte for byte, with or without the paymaster approval in front', () => {
      expect(executedAsSigned(CALLS, GAS, executed(CALLS))).toBe(true);
      expect(executedAsSigned(CALLS, GAS, executed([approve(90_000n), ...CALLS]))).toBe(true);
    });

    it('refuses any other calls', () => {
      expect(executedAsSigned(CALLS, GAS, executed([CALLS[0]]))).toBe(false);
      expect(executedAsSigned(CALLS, GAS, executed([...CALLS, CALLS[0]]))).toBe(false);
      expect(executedAsSigned(CALLS, GAS, executed([CALLS[0], { ...CALLS[1], data: '0xdeadbeee' }]))).toBe(false);
      expect(executedAsSigned(CALLS, GAS, executed([CALLS[0], { ...CALLS[1], value: '0x2' }]))).toBe(false);
      expect(executedAsSigned(CALLS, GAS, executed([CALLS[0], { ...CALLS[1], to: USDC }]))).toBe(false);
      expect(executedAsSigned(CALLS, GAS, executed([approve(maxUint256), ...CALLS]))).toBe(false);
    });
  });
});

describe('typed data', () => {
  const PERMIT = {
    domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: USDC },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: ACCOUNT, spender: RECIPIENT, value: '1000000', nonce: '0', deadline: '1790000000' },
  } as const;
  const MAIL = {
    domain: { name: 'Mail‮', chainId: 84532 },
    types: { Mail: [{ name: 'contents', type: 'string' }] },
    primaryType: 'Mail',
    message: { contents: 'hello' },
  } as const;

  it('refuses the JAW domain, typed data viem rejects, and text Postgres cannot store', () => {
    expect(typedDataRefusal(rejectionTypedData(84532, ID), ACCOUNT)).toBe('reserved_domain');
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, rejectionTypedData(84532, ID)])).toBeDefined();
    expect(typedDataRefusal({ ...MAIL, primaryType: 'Missing' }, ACCOUNT)).toBe('invalid');
    expect(typedDataRefusal({ ...PERMIT, message: { ...PERMIT.message, owner: 'nope' } }, ACCOUNT)).toBe('invalid');
    expect(typedDataRefusal({ ...MAIL, message: { contents: 'a\u0000b' } }, ACCOUNT)).toBe('unstorable');
    expect(typedDataRefusal(PERMIT, ACCOUNT)).toBeUndefined();
  });

  it('signs the stored typed data unchanged', () => {
    const r = opened({ kind: 'typed-data', typedData: PERMIT });
    expect(signedPayload(r, 'approved')).toEqual({ type: 'typed_data', typedData: PERMIT });
    expect(payloadHash(signedPayload(r, 'approved'))).toBe(hashTypedData(PERMIT));
  });

  it('warns that a permit can move tokens', () => {
    const preview = previewOf(opened({ kind: 'typed-data', typedData: PERMIT }), rawCall);
    expect(preview).toMatchObject({ kind: 'typed-data', primaryType: 'Permit', warnings: ['token_permit'] });
    if (preview.kind !== 'typed-data') throw new Error('kind');
    expect(preview.message).toContain(RECIPIENT);
    expect(preview.domain).toContain('USD Coin');
  });

  it('shows hidden characters as code points and warns about another chain', () => {
    const typedData = { ...MAIL, domain: { ...MAIL.domain, chainId: 1 } };
    const preview = previewOf(opened({ kind: 'typed-data', typedData }), rawCall);
    expect(preview).toMatchObject({ warnings: ['hidden_characters', 'chain_mismatch'] });
    if (preview.kind !== 'typed-data') throw new Error('kind');
    expect(preview.domain).toContain('Mail⟦U+202E⟧');
  });
});

describe('Sign in with Ethereum', () => {
  const siwe = (over: Partial<Parameters<typeof createSiweMessage>[0]> = {}) =>
    createSiweMessage({
      address: ACCOUNT,
      chainId: 84532,
      domain: 'app.example',
      uri: 'https://app.example/login',
      version: '1',
      nonce: 'n0nce1234',
      issuedAt: T0,
      expirationTime: later(60_000),
      statement: 'Log in to the app',
      ...over,
    });

  it('routes a message that parses as EIP-4361 to the siwe kind, and anything else to a signature', () => {
    expect(messageBody(siwe(), ACCOUNT, 84532)).toEqual({ kind: 'siwe', message: siwe() });
    expect(messageBody('Sign in to example.com', ACCOUNT, 84532)).toEqual({
      kind: 'signature',
      message: 'Sign in to example.com',
    });
    expect(messageBody('', ACCOUNT, 84532)).toBe('empty');
  });

  it('refuses a login for another account or another chain', () => {
    expect(messageBody(siwe({ address: RECIPIENT }), ACCOUNT, 84532)).toBe('siwe_account');
    expect(messageBody(siwe({ chainId: 8453 }), ACCOUNT, 84532)).toBe('siwe_chain');
  });

  it('signs the stored message unchanged', () => {
    expect(signedPayload(opened({ kind: 'siwe', message: siwe() }), 'approved')).toEqual({
      type: 'message',
      message: siwe(),
    });
  });

  it('previews the login fields and always warns which site it logs into', () => {
    expect(previewOf(opened({ kind: 'siwe', message: siwe() }), rawCall)).toMatchObject({
      kind: 'siwe',
      domain: 'app.example',
      uri: 'https://app.example/login',
      statement: 'Log in to the app',
      nonce: 'n0nce1234',
      issuedAt: T0.toISOString(),
      expirationTime: later(60_000).toISOString(),
      warnings: ['siwe_login'],
    });
  });

  it('leaves out the expiry and the statement when the message has none', () => {
    const bare = siwe({ expirationTime: undefined, statement: undefined });
    expect(previewOf(opened({ kind: 'siwe', message: bare }), rawCall)).toMatchObject({
      statement: null,
      expirationTime: null,
    });
  });
});
