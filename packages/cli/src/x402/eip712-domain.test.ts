import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashDomain } from 'viem';
import type { UsdcAsset } from './asset-registry.js';

const readContract = vi.fn();
vi.mock('./balance.js', () => ({ publicClientFor: () => ({ readContract }) }));

const { whyEip712DomainDisagrees } = await import('./eip712-domain.js');

const BASE_SEPOLIA: UsdcAsset = {
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  chainId: 84532,
  wireNetwork: 'eip155:84532',
  usdcName: 'USDC',
  usdcVersion: '2',
  decimals: 6,
};

/** The separator a deployment carrying these strings computes. */
const separatorFor = (name: string, version: string, asset: UsdcAsset = BASE_SEPOLIA) =>
  hashDomain({
    domain: { name, version, chainId: BigInt(asset.chainId), verifyingContract: asset.address },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });

beforeEach(() => {
  readContract.mockReset();
});

describe('whyEip712DomainDisagrees', () => {
  it('says nothing when the registry produces the separator the token verifies against', async () => {
    readContract.mockResolvedValue(separatorFor('USDC', '2'));

    await expect(whyEip712DomainDisagrees(BASE_SEPOLIA)).resolves.toBeNull();
  });

  it('reports a wrong name, which is the edit a person makes by pattern', async () => {
    // Arbitrum Sepolia is `USD Coin` while the other testnets are `USDC`, so
    // this is the mistake the check exists for.
    readContract.mockResolvedValue(separatorFor('USD Coin', '2'));

    const warning = await whyEip712DomainDisagrees(BASE_SEPOLIA);
    expect(warning).toMatch(/does not match/);
    expect(warning).toContain('eip155:84532');
  });

  it('reports a wrong version', async () => {
    // Gnosis USDC is version 1.
    readContract.mockResolvedValue(separatorFor('USDC', '1'));

    await expect(whyEip712DomainDisagrees(BASE_SEPOLIA)).resolves.toMatch(/does not match/);
  });

  it('catches a token whose name() agrees but whose separator does not', async () => {
    // Bridged USDC on Polygon: `name()` reads `USD Coin (PoS)` while the stored
    // separator was built from `USD Coin`. Comparing names would have passed a
    // registry that says `USD Coin (PoS)`; comparing separators does not.
    const bridged: UsdcAsset = { ...BASE_SEPOLIA, usdcName: 'USD Coin (PoS)' };
    readContract.mockResolvedValue(separatorFor('USD Coin', '2'));

    await expect(whyEip712DomainDisagrees(bridged)).resolves.toMatch(/does not match/);
  });

  it('stays quiet when the chain cannot be asked', async () => {
    // A node that did not answer is not a finding, and this decides nothing.
    readContract.mockRejectedValue(new Error('timed out'));

    await expect(whyEip712DomainDisagrees(BASE_SEPOLIA)).resolves.toBeNull();
  });

  it('never puts the transport error in the message', async () => {
    // viem carries the whole url, api key included, in its error text, and this
    // string reaches the ledger and the MCP client.
    readContract.mockRejectedValue(new Error('HTTP request failed. URL: https://x/rpc?api-key=SECRET'));

    await expect(whyEip712DomainDisagrees(BASE_SEPOLIA)).resolves.toBeNull();
  });
});
