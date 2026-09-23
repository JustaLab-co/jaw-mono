/**
 * Golden vectors: our encoders against bytes produced outside TypeScript.
 *
 * toJustanAccount.encoding.test.ts round-trips what we encode back through the
 * shape we believe the contract reads. That proves we are consistent with
 * ourselves. It cannot tell us whether that shape is the audited one, because
 * both the encoder and the expectation come from this repo.
 *
 * The `expected` in these files was produced by `cast abi-encode` with the
 * struct signature copied from the Solidity, so it is the contract's own
 * statement of the encoding. See vectors/README.md for the exact commands and
 * how to re-derive any of them by hand.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, custom } from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, it, expect } from 'vitest';

import { wrapSignature, toWebAuthnSignature, toJustanAccount } from './toJustanAccount.js';

/** Read rather than imported, so the vectors stay plain data with no build wiring. */
function vectors<T>(name: string): T[] {
    return JSON.parse(readFileSync(new URL(`../../vectors/${name}.json`, import.meta.url), 'utf8'));
}

type WrapVector = { description: string; input: { ownerIndex: number; signature: string }; expected: string };
type WebAuthnVector = {
    description: string;
    input: { signature: string; webauthn: Record<string, unknown> };
    expected: string;
};

type TypedDataSignVector = { description: string; typedData: Record<string, unknown>; expected: string };

const wrapVectors = vectors<WrapVector>('signature-wrap');
const webauthnVectors = vectors<WebAuthnVector>('signature-webauthn');
const typedDataSignVectors = vectors<TypedDataSignVector>('typed-data-sign');

describe('SignatureWrapper, against vectors from the contract struct', () => {
    it.each(wrapVectors)('$description', ({ input, expected }) => {
        expect(wrapSignature({ ownerIndex: input.ownerIndex, signature: input.signature as `0x${string}` })).toBe(
            expected
        );
    });
});

describe('WebAuthnAuth, against vectors from the contract struct', () => {
    it.each(webauthnVectors)('$description', ({ input, expected }) => {
        expect(
            toWebAuthnSignature({
                signature: input.signature as `0x${string}`,
                webauthn: input.webauthn as never,
            })
        ).toBe(expected);
    });
});

describe('ERC-7739 TypedDataSign, against vectors derived with cast', () => {
    // Anvil's second default key, and the account the forge check deployed for it.
    const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const address = '0xf470E70a46414C7aCb92aD6771da22b611C97303';
    // Reports the account as deployed, so viem does not add an ERC-6492 wrapper.
    const client = createPublicClient({
        chain: foundry,
        transport: custom({ request: async ({ method }) => (method === 'eth_getCode' ? '0x01' : null) }),
    });

    it.each(typedDataSignVectors)('$description', async ({ typedData, expected }) => {
        const account = await toJustanAccount({ client, owners: [owner], address });
        expect(await account.signTypedData(typedData as never)).toBe(expected);
    });
});
