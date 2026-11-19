// Whether a restored account can sign for the account a request names. The "no" cases come from
// core itself: `createSmartAccountForAddress` reads the target's code and owners over RPC, and a
// fake transport answers those reads, so the errors under test are the ones core really throws.
import { describe, it, expect, vi } from 'vitest';
import { createSmartAccountForAddress } from '@jaw.id/core';
import { createClient, custom, encodeAbiParameters, pad, toFunctionSelector, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signsFor } from './signsFor';

const SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SIGNERS_OWN = '0x1111111111111111111111111111111111111111' as Address;
const TARGET = '0x2222222222222222222222222222222222222222' as Address;

const NEXT_OWNER_INDEX = toFunctionSelector('nextOwnerIndex()');
const OWNER_AT_INDEX = toFunctionSelector('ownerAtIndex(uint256)');

/** An RPC where TARGET is deployed (or not) and owned by `owners` only. */
function chainWhere({ deployed, owners }: { deployed: boolean; owners: Hex[] }) {
  return createClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'eth_getCode') return deployed ? '0x6080' : '0x';
        if (method === 'eth_call') {
          const data = ((params as Array<{ data?: Hex; input?: Hex }>)[0].data ??
            (params as Array<{ input?: Hex }>)[0].input) as Hex;
          if (data.startsWith(NEXT_OWNER_INDEX))
            return encodeAbiParameters([{ type: 'uint256' }], [BigInt(owners.length)]);
          if (data.startsWith(OWNER_AT_INDEX)) {
            const index = Number(BigInt(`0x${data.slice(10)}`));
            return encodeAbiParameters([{ type: 'bytes' }], [owners[index]]);
          }
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
}

/** A restored account whose signer is SIGNER, resolving other accounts the way `Account` does. */
function restoredOn(client: ReturnType<typeof chainWhere>) {
  return {
    address: SIGNERS_OWN,
    getSmartAccountFor: (address: Address) =>
      createSmartAccountForAddress(address, SIGNER, client as Parameters<typeof createSmartAccountForAddress>[2]),
  };
}

describe('signsFor', () => {
  it('is true for the account the passkey itself created, without asking the chain', async () => {
    const getSmartAccountFor = vi.fn();
    expect(await signsFor({ address: SIGNERS_OWN, getSmartAccountFor }, SIGNERS_OWN.toUpperCase())).toBe(true);
    expect(await signsFor({ address: SIGNERS_OWN, getSmartAccountFor }, undefined)).toBe(true);
    expect(getSmartAccountFor).not.toHaveBeenCalled();
  });

  it('is true when the passkey is an owner of the requested account', async () => {
    const other = pad('0x3333333333333333333333333333333333333333');
    const chain = chainWhere({ deployed: true, owners: [other, pad(SIGNER.address)] });
    expect(await signsFor(restoredOn(chain), TARGET)).toBe(true);
  });

  it('is false when core refuses because the passkey is not an owner', async () => {
    const other = pad('0x3333333333333333333333333333333333333333');
    expect(await signsFor(restoredOn(chainWhere({ deployed: true, owners: [other] })), TARGET)).toBe(false);
  });

  it('is false when the requested account is not deployed, so only its own passkey can sign for it', async () => {
    expect(await signsFor(restoredOn(chainWhere({ deployed: false, owners: [] })), TARGET)).toBe(false);
  });

  it('passes any other failure on, so a network error is not mistaken for the wrong passkey', async () => {
    const account = {
      address: SIGNERS_OWN,
      getSmartAccountFor: async () => {
        throw new Error('fetch failed');
      },
    };
    await expect(signsFor(account, TARGET)).rejects.toThrow('fetch failed');
  });
});
