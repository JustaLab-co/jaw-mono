import { describe, it, expect, vi, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, recoverAddress, sliceHex } from 'viem';
import type { X402PaymentRequirement } from './types.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from './scheme-exact-evm.js';
import { hashTypedData as erc7739HashTypedData } from 'viem/experimental/erc7739';

// Well-known Hardhat test key #1 — never used for real funds.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(PK);

vi.mock('../lib/keystore.js', () => ({
  keystoreExists: vi.fn(() => true),
  loadSessionKey: vi.fn(() => PK),
}));

const getCodeMock = vi.fn();
const readContractMock = vi.fn();
vi.mock('./balance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./balance.js')>();
  return {
    ...actual,
    publicClientFor: () => ({ getCode: getCodeMock, readContract: readContractMock }),
  };
});

const { Eip3009EoaPayer } = await import('./payer.js');

const requirement: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  maxTimeoutSeconds: 60,
};

const ACCOUNT_DOMAIN_TUPLE = [
  '0x0f',
  'JustanAccount',
  '1',
  84532n,
  account.address,
  ('0x' + '00'.repeat(32)) as `0x${string}`,
  [],
];

beforeEach(() => {
  getCodeMock.mockReset();
  readContractMock.mockReset();
});

describe('Eip3009EoaPayer delegation awareness', () => {
  it('signs the plain typed data while the EOA has no code (ecrecover path)', async () => {
    getCodeMock.mockResolvedValue(undefined);
    const payer = Eip3009EoaPayer.fromSessionKey();

    const payload = await payer.pay(requirement, { now: 1_000_000, nonce: ('0x' + '11'.repeat(32)) as `0x${string}` });

    const sig = payload.payload.signature;
    expect((sig.length - 2) / 2).toBe(65);
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: requirement.asset },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address,
        to: requirement.payTo,
        value: 1000n,
        validAfter: 0n,
        validBefore: BigInt(1_000_000 + 600),
        nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
      },
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('signs the ERC-7739 wrapped envelope once the EOA carries the 7702 designator', async () => {
    getCodeMock.mockResolvedValue('0xef0100bb4f7d5418cd8dadb61bb95561179e517572cbcd');
    readContractMock.mockResolvedValue(ACCOUNT_DOMAIN_TUPLE);
    const payer = Eip3009EoaPayer.fromSessionKey();

    const payload = await payer.pay(requirement, { now: 1_000_000, nonce: ('0x' + '11'.repeat(32)) as `0x${string}` });

    const sig = payload.payload.signature;
    expect((sig.length - 2) / 2).toBeGreaterThan(65); // wrapped blob, not a bare sig
    expect(readContractMock).toHaveBeenCalledWith(
      expect.objectContaining({ address: account.address, functionName: 'eip712Domain' })
    );
    // The inner 65-byte signature recovers to the EOA over the envelope digest.
    const digest = erc7739HashTypedData({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: requirement.asset },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address,
        to: requirement.payTo,
        value: 1000n,
        validAfter: 0n,
        validBefore: BigInt(1_000_000 + 600),
        nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
      },
      verifierDomain: {
        name: 'JustanAccount',
        version: '1',
        chainId: 84532n,
        verifyingContract: account.address,
        salt: ('0x' + '00'.repeat(32)) as `0x${string}`,
      },
    } as never);
    const recovered = await recoverAddress({ hash: digest, signature: sliceHex(sig, 0, 65) });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('caches the account domain across payments (one eip712Domain read)', async () => {
    getCodeMock.mockResolvedValue('0xef0100bb4f7d5418cd8dadb61bb95561179e517572cbcd');
    readContractMock.mockResolvedValue(ACCOUNT_DOMAIN_TUPLE);
    const payer = Eip3009EoaPayer.fromSessionKey();

    await payer.pay(requirement);
    await payer.pay(requirement);

    expect(readContractMock).toHaveBeenCalledTimes(1);
  });

  it('reads the account domain per chain (a chain B payment never reuses chain A domain)', async () => {
    // The envelope embeds the account domain's chainId; reusing chain A's
    // domain on chain B would produce signatures the verifier rejects.
    getCodeMock.mockResolvedValue('0xef0100bb4f7d5418cd8dadb61bb95561179e517572cbcd');
    readContractMock.mockResolvedValue(ACCOUNT_DOMAIN_TUPLE);
    const payer = Eip3009EoaPayer.fromSessionKey();

    await payer.pay(requirement); // eip155:84532
    await payer.pay({ ...requirement, network: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' });

    expect(readContractMock).toHaveBeenCalledTimes(2);
  });

  // The fourth read the bounded transport covers. A delegated account signs a
  // wrapped envelope carrying its own domain, so a domain that cannot be read is
  // a signature that cannot be built. Refuse, rather than fall back to the raw
  // one the account would reject anyway.
  it('refuses to sign when the account domain cannot be read', async () => {
    getCodeMock.mockResolvedValue('0xef0100bb4f7d5418cd8dadb61bb95561179e517572cbcd');
    readContractMock.mockRejectedValue(new Error('rpc timed out'));
    const payer = Eip3009EoaPayer.fromSessionKey();

    await expect(payer.pay(requirement)).rejects.toThrow(/rpc timed out/);
  });

  // Guessing raw here would be the cheap fallback. A delegated account refuses
  // that signature, the refusal reads as a failed payment, and a failed payment is
  // counted against the session cap on the grounds the facilitator may have
  // broadcast it. It cannot have, so the guess spends budget on a payment that
  // could never settle. Refusing before signing costs a retry instead.
  it('refuses to sign when it cannot tell whether the account is delegated', async () => {
    getCodeMock.mockRejectedValue(new Error('rpc down'));
    const payer = Eip3009EoaPayer.fromSessionKey();

    await expect(payer.pay(requirement)).rejects.toThrow(/rpc down/);
  });
});

/**
 * An `upto` payment moves tokens through Permit2's allowance. A payer that never
 * approved it signs an authorization the proxy cannot execute, the settlement
 * fails, and by the ledger's rule the failed attempt reserves its whole ceiling
 * against the cap. So the allowance is read before signing, for the same reason
 * the delegation check is: refusing costs a retry, guessing costs the budget.
 */
describe('Eip3009EoaPayer paying upto', () => {
  const uptoRequirement = {
    ...requirement,
    scheme: 'upto' as const,
    amount: '5000000',
    extra: { facilitatorAddress: '0x1111111111111111111111111111111111111111' },
  };

  it('refuses before signing when Permit2 was never approved', async () => {
    getCodeMock.mockResolvedValue('0x');
    readContractMock.mockResolvedValue(0n);
    const payer = Eip3009EoaPayer.fromSessionKey();

    await expect(payer.pay(uptoRequirement)).rejects.toThrow(/approved Permit2/);
  });

  // The bounded transport turns a hung node into an error sooner, which is what
  // makes this path a common one. An unreadable allowance must refuse the
  // same way an unreadable delegation does: signing a Permit2 authorization the
  // proxy cannot execute reserves its whole ceiling against the cap for nothing.
  it('refuses before signing when the allowance cannot be read', async () => {
    getCodeMock.mockResolvedValue('0x');
    readContractMock.mockRejectedValue(new Error('rpc timed out'));
    const payer = Eip3009EoaPayer.fromSessionKey();

    await expect(payer.pay(uptoRequirement)).rejects.toThrow(/rpc timed out/);
  });

  it('refuses when the allowance is smaller than the ceiling it would authorize', async () => {
    getCodeMock.mockResolvedValue('0x');
    readContractMock.mockResolvedValue(4_999_999n);
    const payer = Eip3009EoaPayer.fromSessionKey();

    await expect(payer.pay(uptoRequirement)).rejects.toThrow(/approved Permit2/);
  });

  /**
   * The funder reads this allowance to decide whether to grant one, on the same
   * contract through the same client, moments earlier. Asking again inside the
   * same payment is the same question twice.
   */
  it('takes the allowance the funder already read instead of asking the chain again', async () => {
    getCodeMock.mockResolvedValue('0x');
    readContractMock.mockRejectedValue(new Error('the chain must not be asked'));
    const payer = Eip3009EoaPayer.fromSessionKey();

    const payload = await payer.pay(uptoRequirement, {
      permit2Allowance: 2n ** 256n - 1n,
      now: 1_000_000,
      nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
    });

    expect(payload.payload).toHaveProperty('permit2Authorization');
  });

  /** A figure short of the ceiling is not an answer, so the chain still decides. */
  it('still reads the chain when the figure it was handed does not cover the ceiling', async () => {
    getCodeMock.mockResolvedValue('0x');
    readContractMock.mockResolvedValue(2n ** 256n - 1n);
    const payer = Eip3009EoaPayer.fromSessionKey();

    await payer.pay(uptoRequirement, {
      permit2Allowance: 4_999_999n,
      now: 1_000_000,
      nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
    });

    expect(readContractMock).toHaveBeenCalled();
  });

  it('signs a Permit2 authorization once the allowance covers it', async () => {
    getCodeMock.mockResolvedValue('0x');
    readContractMock.mockResolvedValue(2n ** 256n - 1n);
    const payer = Eip3009EoaPayer.fromSessionKey();

    const payload = await payer.pay(uptoRequirement, {
      now: 1_000_000,
      nonce: ('0x' + '11'.repeat(32)) as `0x${string}`,
    });

    expect(payload.payload).toHaveProperty('permit2Authorization');
    expect(payload.payload).not.toHaveProperty('authorization');
  });
});
