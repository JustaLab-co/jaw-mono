import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { buildExactPayment, encodePaymentPayload, TRANSFER_WITH_AUTHORIZATION_TYPES } from './scheme-exact-evm.js';
import type { X402PaymentRequirement } from './types.js';

// Well-known Hardhat test key #1 — never used for real funds.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(PK);
const NONCE = ('0x' + '11'.repeat(32)) as `0x${string}`;

const requirement: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  maxTimeoutSeconds: 60,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const signer = (td: any) => account.signTypedData(td);

describe('buildExactPayment', () => {
  it('signs a recoverable EIP-3009 authorization for the payer', async () => {
    const payload = await buildExactPayment(requirement, account.address, signer, { now: 1_000_000, nonce: NONCE });

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirement);

    const auth = payload.payload.authorization;
    expect(auth.from).toBe(account.address);
    expect(auth.to).toBe(requirement.payTo);
    expect(auth.value).toBe('1000');
    expect(auth.validAfter).toBe('0');
    expect(auth.validBefore).toBe(String(1_000_000 + 600));
    expect(auth.nonce).toBe(NONCE);

    // The signature must recover to the payer under the exact-scheme domain.
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
        nonce: NONCE,
      },
      signature: payload.payload.signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('ignores a server-advertised EIP-712 domain in favour of the registry', async () => {
    // `extra` is server-controlled, and for a token the registry knows the
    // server's claim can only agree, adding nothing, or disagree, producing a
    // signature the token rejects and a failed payment that reserves its whole
    // ceiling. The registry's own values are checked against the token by
    // `whyEip712DomainDisagrees`.
    const req = { ...requirement, extra: { name: 'Custom', version: '9' } };
    const payload = await buildExactPayment(req, account.address, signer, { now: 1_000_000, nonce: NONCE });

    // Recovers under the registry's domain, not the advertised one.
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
        nonce: NONCE,
      },
      signature: payload.payload.signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('refuses a zero recipient the policy would have skipped', async () => {
    const zero = { ...requirement, payTo: `0x${'0'.repeat(40)}` as `0x${string}` };
    await expect(buildExactPayment(zero, account.address, signer)).rejects.toThrow(/zero address/);
  });

  it('rejects an unsupported network', async () => {
    await expect(buildExactPayment({ ...requirement, network: 'eip155:1' }, account.address, signer)).rejects.toThrow(
      /Unsupported x402 network/
    );
  });

  it('rejects a server-chosen asset that is not the registry USDC for the network', async () => {
    // The asset becomes the EIP-712 verifyingContract — signing whatever the
    // server sends would authorize a transfer on an arbitrary ERC-3009 token.
    const rogue = { ...requirement, asset: '0x0000000000000000000000000000000000000bad' as `0x${string}` };
    await expect(buildExactPayment(rogue, account.address, signer)).rejects.toThrow(/asset mismatch/);
  });

  /**
   * The mismatch check above compares case-insensitively, so an asset that is
   * the registry's USDC in the wrong casing gets past it, and a mixed-case
   * string failing EIP-55 is one viem refuses at signing time, with the payer
   * already topped up. Re-casing is not open to us: `accepted` echoes the
   * requirement byte for byte, so a normalised payload would disagree with it.
   * Refused during selection instead; this is the signer's own precondition.
   */
  it('refuses a challenge whose addresses cannot be read', async () => {
    const misCased = (a: string) => a.toUpperCase().replace('0X', '0x');
    const shouty = { ...requirement, payTo: misCased(requirement.payTo) as `0x${string}` };
    await expect(buildExactPayment(shouty, account.address, signer)).rejects.toThrow(/payTo is not a readable address/);
    // The asset too: the mismatch check above it compares case-insensitively,
    // so an unreadable spelling of the registry's USDC gets past that one.
    const badAsset = { ...requirement, asset: misCased(requirement.asset) as `0x${string}` };
    await expect(buildExactPayment(badAsset, account.address, signer)).rejects.toThrow(
      /asset is not a readable address/
    );
  });

  /**
   * The two spellings a real server uses round-trip untouched, which is what
   * lets a facilitator match the payload against its own challenge.
   */
  it('echoes a parseable recipient byte for byte', async () => {
    for (const spell of [(a: string) => a, (a: string) => a.toLowerCase()]) {
      const req = { ...requirement, payTo: spell(requirement.payTo) as `0x${string}` };
      const echoed = await buildExactPayment(req, account.address, signer, { now: 1_000_000, nonce: NONCE });
      expect(echoed.payload.authorization.to).toBe(req.payTo);
    }
  });
});
describe('encodePaymentPayload', () => {
  it('base64-encodes round-trippable JSON', async () => {
    const payload = await buildExactPayment(requirement, account.address, signer, { now: 1_000_000, nonce: NONCE });
    const decoded = JSON.parse(Buffer.from(encodePaymentPayload(payload), 'base64').toString());
    expect(decoded.accepted.payTo).toBe(requirement.payTo);
    expect(decoded.payload.signature).toBe(payload.payload.signature);
    expect(decoded.payload.authorization.nonce).toBe(NONCE);
  });
});
