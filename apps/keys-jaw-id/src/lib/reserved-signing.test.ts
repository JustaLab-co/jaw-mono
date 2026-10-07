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
const cases: [string, unknown[]][] = [
  ['personal_sign', ['JAW connection consent', ACCOUNT]],
  ['personal_sign', [stringToHex('JAW connection consent'), ACCOUNT]],
  ['personal_sign', ['Hello JAW', ACCOUNT]],
  ['eth_signTypedData_v4', [ACCOUNT, JSON.stringify(consent)]],
  ['eth_signTypedData_v4', [ACCOUNT, rejectionTypedData(8453, 'id')]],
  ['eth_signTypedData_v4', [ACCOUNT, JSON.stringify({ ...consent, domain: { ...consent.domain, name: 'JAWS' } })]],
  ['wallet_sign', [{ request: { type: '0x01', data: consent } }]],
  ['wallet_sign', [{ request: { type: '0x45', data: { message: 'JAW consent' } } }]],
  ['wallet_sendCalls', [{ calls: [] }]],
];

describe('the reserved signing rule in @jaw.id/ui', () => {
  it.each(cases)('agrees with @jaw.id/agent on %s %j', (method, params) => {
    expect(uiRule(method, params)).toBe(agentRule(method, params));
  });
});
