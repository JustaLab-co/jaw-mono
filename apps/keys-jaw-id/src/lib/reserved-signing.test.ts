import { consentTypedData, rejectionTypedData, reservedSigningRefusal as agentRule } from '@jaw.id/agent/reserved';
import { reservedSigningRefusal as uiRule } from '@jaw.id/ui';
import { stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';

// @jaw.id/ui keeps its own copy of the rule, because a published package cannot
// depend on the private agent package. The two must refuse exactly the same requests.
const ACCOUNT = '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F';
const consent = consentTypedData(8453, {
  issuer: 'https://mcp.jaw.id',
  interaction: 'uid_1234567890',
  clientId: 'jaw-cli',
  clientName: 'JAW CLI',
  scopes: 'wallet:read wallet:send',
  expires: '2026-10-07T12:00:00.000Z',
});
const R = 'refused';
const OK = 'allowed';
const cases: [string, unknown, typeof R | typeof OK][] = [
  ['personal_sign', ['JAW connection consent', ACCOUNT], R],
  ['personal_sign', [stringToHex('JAW connection consent'), ACCOUNT], R],
  ['personal_sign', [ACCOUNT, 'JAW connection consent'], R],
  ['personal_sign', 'JAW connection consent', R],
  ['personal_sign', ['Hello JAW', ACCOUNT], OK],
  ['personal_sign', ['JAWS', ACCOUNT], OK],
  ['eth_signTypedData_v4', [ACCOUNT, JSON.stringify(consent)], R],
  ['eth_signTypedData_v4', [ACCOUNT, consent], R],
  ['eth_signTypedData_v4', [ACCOUNT, rejectionTypedData(8453, 'id')], R],
  ['eth_signTypedData_v3', [ACCOUNT, JSON.stringify(consent)], R],
  ['eth_signTypedData_v4', [ACCOUNT, JSON.stringify({ ...consent, domain: { ...consent.domain, name: 'JAWS' } })], OK],
  ['eth_signTypedData_v4', [ACCOUNT, '{not json'], OK],
  ['eth_signTypedData_v4', JSON.stringify(consent), R],
  ['wallet_sign', [{ request: { type: '0x01', data: consent } }], R],
  ['wallet_sign', [{ request: { type: '0x45', data: { message: 'JAW consent' } } }], R],
  ['wallet_sign', [{ request: { type: '0x45', data: { message: 'Sign in to Example' } } }], OK],
  ['wallet_sign', [{}], OK],
  ['wallet_sendCalls', [{ calls: [] }], OK],
];

describe('the reserved signing rule', () => {
  it.each(cases)('%s %j is %s by both copies', (method, params, expected) => {
    const outcome = (rule: typeof agentRule) => (rule(method, params) ? R : OK);
    expect(outcome(agentRule)).toBe(expected);
    expect(outcome(uiRule)).toBe(expected);
  });
});
