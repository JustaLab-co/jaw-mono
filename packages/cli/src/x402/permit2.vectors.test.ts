import { describe, it, expect } from 'vitest';
import { hashStruct, hashDomain, getTypesForEIP712Domain, keccak256, toHex } from 'viem';
import {
  PERMIT2_ADDRESS,
  PERMIT_WITNESS_TRANSFER_FROM_TYPES,
  permit2Domain,
  X402_UPTO_PROXY_ADDRESS,
  type UptoPermitMessage,
} from './permit2.js';

/**
 * Golden vectors for the Permit2 `upto` declarations.
 *
 * A wrong byte in an EIP-712 type string produces a signature that fails
 * validation with no useful error, and the only other place it would surface is
 * a live settlement. So the strings are frozen against the contract source, and
 * the struct hash is checked against viem, which encodes the type from the types
 * object rather than from our string. The two agree only if the string is right.
 *
 * Sourced from `x402UptoPermit2Proxy.sol` in coinbase/x402
 * (`contracts/evm/src/`), whose `WITNESS_TYPE_STRING` is reproduced verbatim
 * below, and from Permit2's `_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB`.
 *
 * What the signer then does with these is pinned in `erc7739.vectors.test.ts`.
 */

/** Fixed inputs. Values are arbitrary but must never change. */
const message: UptoPermitMessage = {
  permitted: { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: 5_000_000n },
  spender: X402_UPTO_PROXY_ADDRESS,
  nonce: BigInt('0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480'),
  deadline: 1_740_672_154n,
  witness: {
    to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    facilitator: '0x1111111111111111111111111111111111111111',
    validAfter: 1_740_672_089n,
  },
};

const structHash = () =>
  hashStruct({ data: message, primaryType: 'PermitWitnessTransferFrom', types: PERMIT_WITNESS_TRANSFER_FROM_TYPES });

describe('permit2 upto type strings', () => {
  // The transcription itself is checked in `erc7739.vectors.test.ts`, against
  // the type viem derives from the structs. Asserting the constant equals a
  // second copy of the same string could only fail by editing both, so this
  // pins the hash instead.
  it('pins the witness typehash the proxy checks against', () => {
    expect(keccak256(toHex('Witness(address to,address facilitator,uint256 validAfter)'))).toBe(
      '0xd4171c445a74218b01d4fd8af34ff1106580ea1e36ff837e64484bfaa2253b75'
    );
  });

  it('hashes the fixed message to the golden struct hash', () => {
    // viem encodes the type from the types object, so this value depends on the
    // struct definitions rather than on our string. That the two describe the
    // same type is asserted in `erc7739.vectors.test.ts`, which reads viem's
    // derived string back out of the signed blob and compares it to the
    // constant above.
    expect(structHash()).toBe('0x482b7b2efc1e90d0583360483bee6afe097d47c281552f14b440443cdcfd5368');
  });
});

describe('permit2 domain', () => {
  it('has no version field, matching Permit2 DOMAIN_SEPARATOR', () => {
    const domain = permit2Domain(84532);
    expect(domain).toEqual({ name: 'Permit2', chainId: 84532, verifyingContract: PERMIT2_ADDRESS });
    expect(hashDomain({ domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }) } } as never)).toBe(
      '0x010f27a92fb9a32622f44f001dc4d15706a85b33499cfc2ce9033113ab26592c'
    );
  });
});
