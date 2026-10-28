import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { buildUptoPayment } from './scheme-upto-evm.js';
import { X402_UPTO_PROXY_ADDRESS, PERMIT_WITNESS_TRANSFER_FROM_TYPES, permit2Domain } from './permit2.js';
import type { X402PaymentRequirement, X402UptoPayload } from './types.js';

// Well-known Hardhat test key #1 — never used for real funds.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(PK);
const NONCE = ('0x' + '11'.repeat(32)) as `0x${string}`;
const FACILITATOR = '0x1111111111111111111111111111111111111111';
// One with letters in it, so casing is something that can actually be wrong.
const FACILITATOR_MIXED = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
// The replace keeps the 0x prefix lowercase, so the string is still an address.
const misCased = (a: string) => a.toUpperCase().replace('0X', '0x');

const requirement: X402PaymentRequirement = {
  scheme: 'upto',
  network: 'eip155:84532',
  amount: '5000000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2', facilitatorAddress: FACILITATOR },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const signer = (td: any) => account.signTypedData(td);
const build = (req = requirement, opts = { now: 1_000_000, nonce: NONCE }) =>
  buildUptoPayment(req, account.address, signer, opts);
const authOf = (payload: { payload: unknown }) => (payload.payload as X402UptoPayload).permit2Authorization;

describe('buildUptoPayment', () => {
  it('signs a recoverable Permit2 authorization for the payer', async () => {
    const payload = await build();
    const auth = authOf(payload);

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirement);
    expect(auth.from).toBe(account.address);

    const recovered = await recoverTypedDataAddress({
      domain: permit2Domain(84532),
      types: PERMIT_WITNESS_TRANSFER_FROM_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: requirement.asset, amount: 5_000_000n },
        spender: X402_UPTO_PROXY_ADDRESS,
        nonce: BigInt(NONCE),
        deadline: 1_000_600n,
        witness: { to: requirement.payTo, facilitator: FACILITATOR, validAfter: 999_940n },
      },
      signature: (payload.payload as X402UptoPayload).signature,
    } as never);
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('authorizes the ceiling the server advertised, not more', async () => {
    expect(authOf(await build()).permitted.amount).toBe('5000000');
  });

  it('names the pinned proxy as spender, never anything the server chose', async () => {
    const fromChallenge = { ...requirement, extra: { ...requirement.extra, spender: '0xdead'.padEnd(42, '0') } };
    expect(authOf(await build(fromChallenge)).spender).toBe(X402_UPTO_PROXY_ADDRESS);
  });

  it('binds the recipient and the facilitator in the witness', async () => {
    const auth = authOf(await build());
    expect(auth.witness.to).toBe(requirement.payTo);
    expect(auth.witness.facilitator).toBe(FACILITATOR);
  });

  it('floors the deadline at ten minutes when the server asks for less', async () => {
    expect(authOf(await build()).deadline).toBe(String(1_000_000 + 600));
  });

  it('honours a longer window when the server asks for one', async () => {
    const patient = { ...requirement, maxTimeoutSeconds: 3600 };
    expect(authOf(await build(patient)).deadline).toBe(String(1_000_000 + 3600));
  });

  it('backdates validAfter so a fast clock cannot sign something not yet valid', async () => {
    expect(authOf(await build()).witness.validAfter).toBe(String(1_000_000 - 60));
  });

  it('never backdates below zero', async () => {
    expect(authOf(await build(requirement, { now: 10, nonce: NONCE })).witness.validAfter).toBe('0');
  });

  it('uses a fresh nonce per call, since Permit2 consumes it once', async () => {
    const a = authOf(await buildUptoPayment(requirement, account.address, signer, { now: 1_000_000 }));
    const b = authOf(await buildUptoPayment(requirement, account.address, signer, { now: 1_000_000 }));
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('serializes the amounts and timestamps as strings, the way they arrived', async () => {
    const auth = authOf(await build());
    expect(typeof auth.permitted.amount).toBe('string');
    expect(typeof auth.deadline).toBe('string');
    expect(typeof auth.witness.validAfter).toBe('string');
  });

  /**
   * A mixed-case string that fails EIP-55 is indistinguishable from a typo, so
   * viem refuses it and so does every other client downstream. We cannot re-case
   * our way out, because `accepted` echoes the requirement byte for byte and the
   * two halves of the document would disagree. Refused during selection instead,
   * where it costs nothing; this is the signer's own precondition.
   */
  it('refuses a challenge whose addresses cannot be read', async () => {
    await expect(build({ ...requirement, payTo: misCased(requirement.payTo) as `0x${string}` })).rejects.toThrow(
      /payTo is not a readable address/
    );
    await expect(build({ ...requirement, asset: misCased(requirement.asset) as `0x${string}` })).rejects.toThrow(
      /asset is not a readable address/
    );
    // Present and hex-shaped but unreadable reads differently from absent, so
    // whoever hits it is not sent looking for a field that is right there.
    const badFacilitator = { ...requirement, extra: { facilitatorAddress: misCased(FACILITATOR_MIXED) } };
    await expect(build(badFacilitator)).rejects.toThrow(/facilitatorAddress is not a readable address/);
    await expect(build({ ...requirement, extra: {} })).rejects.toThrow(/needs a settling facilitator/);
  });

  /**
   * The casing a counterparty can parse is echoed back untouched, which is the
   * whole point of echoing: both spellings a real server uses round-trip.
   */
  it('echoes a parseable challenge byte for byte', async () => {
    for (const spell of [(a: string) => a, (a: string) => a.toLowerCase()]) {
      const req = {
        ...requirement,
        asset: spell(requirement.asset) as `0x${string}`,
        payTo: spell(requirement.payTo) as `0x${string}`,
        extra: { ...requirement.extra, facilitatorAddress: spell(FACILITATOR_MIXED) },
      };

      const auth = authOf(await build(req));

      expect(auth.permitted.token).toBe(req.asset);
      expect(auth.witness.to).toBe(req.payTo);
      expect(auth.witness.facilitator).toBe(req.extra.facilitatorAddress);
    }
  });
});

describe('buildUptoPayment refusals', () => {
  it('refuses a requirement for another scheme', async () => {
    await expect(build({ ...requirement, scheme: 'exact' })).rejects.toThrow(/Not an upto requirement/);
  });

  it('refuses a network with no USDC in the registry', async () => {
    await expect(build({ ...requirement, network: 'eip155:1234' })).rejects.toThrow(/Unsupported x402 network/);
  });

  it('refuses a token that is not the registry USDC for the network', async () => {
    const rogue = { ...requirement, asset: '0x1234567890123456789012345678901234567890' as `0x${string}` };
    await expect(build(rogue)).rejects.toThrow(/asset mismatch/);
  });

  it('refuses when the challenge names no facilitator to settle it', async () => {
    await expect(build({ ...requirement, extra: { name: 'USDC' } })).rejects.toThrow(/facilitatorAddress/);
  });

  it('refuses a chain the settlement proxy was never verified on', async () => {
    const polygon = {
      ...requirement,
      network: 'eip155:137',
      asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`,
    };
    await expect(build(polygon)).rejects.toThrow(/only verified on/);
  });

  it('caps the deadline the server may ask for', async () => {
    const forever = { ...requirement, maxTimeoutSeconds: 31_536_000 };
    expect(authOf(await build(forever)).deadline).toBe(String(1_000_000 + 3600));
  });

  it('refuses a zero recipient the policy would have skipped', async () => {
    const zero = { ...requirement, payTo: `0x${'0'.repeat(40)}` as `0x${string}` };
    await expect(build(zero)).rejects.toThrow(/zero address/);
  });

  it('refuses a zero facilitator, naming the field rather than calling it absent', async () => {
    const zero = { ...requirement, extra: { facilitatorAddress: `0x${'0'.repeat(40)}` } };
    await expect(build(zero)).rejects.toThrow(/needs a settling facilitator/);
  });

  it('refuses a facilitator that is not an address', async () => {
    const bad = { ...requirement, extra: { facilitatorAddress: 'not-an-address' } };
    await expect(build(bad)).rejects.toThrow(/facilitatorAddress/);
  });
});
