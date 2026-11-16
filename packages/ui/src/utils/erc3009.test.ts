import { describe, expect, it } from 'vitest';
import { readErc3009 } from './erc3009';
import { AUTH_FIELDS as AUTH, erc3009TypedData, PAYEE, PAYER, USDC_BASE } from './erc3009.fixtures';

describe('readErc3009', () => {
  it('reads a TransferWithAuthorization as a payment: from, to, amount and token', () => {
    expect(readErc3009(erc3009TypedData())).toEqual({
      primaryType: 'TransferWithAuthorization',
      from: PAYER,
      to: PAYEE,
      value: 1_000_000n,
      token: USDC_BASE,
      validAfter: 0n,
      validBefore: 1_893_456_000n,
    });
  });

  // The validity window is shown on the card, so a message it cannot read is not shown as a payment.
  it('is not a payment when the validity window is not a number', () => {
    expect(readErc3009(erc3009TypedData({ message: { validBefore: 'soon' } }))).toBeNull();
    expect(readErc3009(erc3009TypedData({ message: { validAfter: undefined } }))).toBeNull();
  });

  it('reads a ReceiveWithAuthorization the same way', () => {
    expect(readErc3009(erc3009TypedData({ primaryType: 'ReceiveWithAuthorization' }))).toMatchObject({
      primaryType: 'ReceiveWithAuthorization',
      from: PAYER,
      to: PAYEE,
      value: 1_000_000n,
    });
  });

  it('matches any token, not only USDC', () => {
    const other = '0x2222222222222222222222222222222222222222';
    const typedData = erc3009TypedData({ domain: { name: 'Some Token', version: '1', verifyingContract: other } });
    expect(readErc3009(typedData)?.token).toBe(other);
  });

  it('is not a payment for CancelAuthorization', () => {
    const typedData = {
      ...erc3009TypedData(),
      primaryType: 'CancelAuthorization',
      types: {
        CancelAuthorization: [
          { name: 'authorizer', type: 'address' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      message: { authorizer: PAYER, nonce: `0x${'ab'.repeat(32)}` },
    };
    expect(readErc3009(typedData)).toBeNull();
  });

  it('is not a payment for a Permit', () => {
    const typedData = {
      ...erc3009TypedData(),
      primaryType: 'Permit',
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      message: { owner: PAYER, spender: PAYEE, value: '1', nonce: '0', deadline: '1893456000' },
    };
    expect(readErc3009(typedData)).toBeNull();
  });

  // The name alone is not enough: the struct must hash to the standard's type hash.
  it('is not a payment when the fields are reordered', () => {
    const [from, to, ...rest] = AUTH;
    expect(readErc3009(erc3009TypedData({ fields: [to, from, ...rest] }))).toBeNull();
  });

  it('is not a payment when a field is renamed', () => {
    const fields = AUTH.map((f) => (f.name === 'value' ? { ...f, name: 'amount' } : f));
    expect(readErc3009(erc3009TypedData({ fields }))).toBeNull();
  });

  it('is not a payment when a field is added', () => {
    expect(readErc3009(erc3009TypedData({ fields: [...AUTH, { name: 'memo', type: 'string' }] }))).toBeNull();
  });

  it('is not a payment when the amount is not a number', () => {
    expect(readErc3009(erc3009TypedData({ message: { value: 'lots' } }))).toBeNull();
  });

  it('is not a payment when the domain has no verifying contract', () => {
    expect(readErc3009(erc3009TypedData({ domain: { verifyingContract: undefined } }))).toBeNull();
  });
});
