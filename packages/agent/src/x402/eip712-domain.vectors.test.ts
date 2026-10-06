import { describe, it, expect } from 'vitest';
import { hashDomain } from 'viem';

/**
 * Pins the separator the registry's own values produce, against a hash read off
 * the chain rather than computed here.
 *
 * `eip712-domain.test.ts` builds its expectations with the same `hashDomain`
 * call and the same field list the implementation uses, so it cannot catch a
 * wrong field set or a wrong order: it would agree with itself. These three are
 * the values `DOMAIN_SEPARATOR()` returned on 2026-09-10, so a change to either
 * side of that comparison shows up here.
 */

const EIP712_DOMAIN_TYPE = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const;

const VECTORS = [
  {
    what: 'USDC on Base',
    name: 'USD Coin',
    version: '2',
    chainId: 8453n,
    verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    separator: '0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f',
  },
  {
    what: 'USDC on Base Sepolia, where the deployment is named USDC and not USD Coin',
    name: 'USDC',
    version: '2',
    chainId: 84532n,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    separator: '0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818',
  },
  {
    what: 'USDC on Polygon',
    name: 'USD Coin',
    version: '2',
    chainId: 137n,
    verifyingContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    separator: '0xcaa2ce1a5703ccbe253a34eb3166df60a705c561b44b192061e28f2a985be2ca',
  },
] as const;

describe('EIP-712 domain vectors', () => {
  for (const v of VECTORS) {
    it(`hashes ${v.what} to the separator the token reports`, () => {
      const hashed = hashDomain({
        domain: {
          name: v.name,
          version: v.version,
          chainId: v.chainId,
          verifyingContract: v.verifyingContract as `0x${string}`,
        },
        types: EIP712_DOMAIN_TYPE,
      });
      expect(hashed).toBe(v.separator);
    });
  }
});
