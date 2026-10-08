import { hashTypedData, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  connectionsSignInTypedData,
  consentTypedData,
  rejectionTypedData,
  RESERVED_SIGNING_REFUSAL,
  reservedSigningRefusal,
} from './reserved.js';

const ACCOUNT = '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F';
const terms = {
  issuer: 'https://mcp.jaw.id',
  interaction: 'uid_1234567890',
  clientId: 'jaw-cli',
  clientName: 'JAW CLI',
  scopes: 'wallet:read',
  expires: '2026-10-07T12:00:00.000Z',
};
const consent = consentTypedData(8453, terms);

describe('reserved signing requests', () => {
  it('refuses JAW typed data on every typed data path, as an object or a JSON string', () => {
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(consent)])).toBe(
      RESERVED_SIGNING_REFUSAL
    );
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, rejectionTypedData(8453, 'id')])).toBeDefined();
    expect(reservedSigningRefusal('eth_signTypedData', [consent, ACCOUNT])).toBeDefined();
    expect(reservedSigningRefusal('wallet_sign', [{ request: { type: '0x01', data: consent } }])).toBeDefined();
  });

  it('refuses a personal_sign that starts with the reserved prefix, as text or hex', () => {
    const text = 'JAW connection consent\nmcp.jaw.id asks to connect an app to your JAW account.';
    expect(reservedSigningRefusal('personal_sign', [text, ACCOUNT])).toBe(RESERVED_SIGNING_REFUSAL);
    expect(reservedSigningRefusal('personal_sign', [stringToHex(text), ACCOUNT])).toBeDefined();
    expect(reservedSigningRefusal('personal_sign', [ACCOUNT, text])).toBeDefined();
    expect(
      reservedSigningRefusal('wallet_sign', [{ request: { type: '0x45', data: { message: text } } }])
    ).toBeDefined();
  });

  it('lets other messages, other domains and other methods through', () => {
    const other = { ...consent, domain: { ...consent.domain, name: 'JAW Wallet' } };
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(other)])).toBeUndefined();
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, '{not json'])).toBeUndefined();
    expect(reservedSigningRefusal('personal_sign', ['Hello JAW friends', ACCOUNT])).toBeUndefined();
    expect(reservedSigningRefusal('personal_sign', ['JAWS', ACCOUNT])).toBeUndefined();
    expect(reservedSigningRefusal('wallet_sendCalls', [{ calls: [] }])).toBeUndefined();
  });

  it('binds the interaction, the client, the scopes, the chain and the expiry', () => {
    const base = hashTypedData(consent);
    for (const [field, value] of Object.entries(terms)) {
      expect(hashTypedData(consentTypedData(8453, { ...terms, [field]: `${value}x` })), field).not.toBe(base);
    }
    expect(hashTypedData(consentTypedData(84532, terms))).not.toBe(base);
  });

  it('reserves the connections sign-in, which binds the server and an expiry', () => {
    const signIn = connectionsSignInTypedData(8453, {
      issuer: 'https://mcp.jaw.id',
      expires: '2026-10-07T12:10:00.000Z',
    });
    expect(signIn).toMatchObject({
      domain: { name: 'JAW', version: '1', chainId: 8453 },
      primaryType: 'ConnectionsSignIn',
      message: { issuer: 'https://mcp.jaw.id', expires: '2026-10-07T12:10:00.000Z' },
    });
    expect(reservedSigningRefusal('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(signIn)])).toBe(
      RESERVED_SIGNING_REFUSAL
    );
  });
});
