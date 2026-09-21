import { describe, expect, it } from 'vitest';
import { normalizeAddFundsParams } from './addFundsParams.js';
import { standardErrorCodes } from '../errors/index.js';

const invalidParams = expect.objectContaining({ code: standardErrorCodes.rpc.invalidParams });

describe('normalizeAddFundsParams', () => {
    // Unlike the other normalizers, an empty envelope is legal: calling
    // wallet_addFunds with no arguments is the common case.
    it('treats an absent parameter as an empty request', () => {
        expect(normalizeAddFundsParams(undefined)).toEqual({ chainId: undefined });
        expect(normalizeAddFundsParams([])).toEqual({ chainId: undefined });
        expect(normalizeAddFundsParams([{}])).toEqual({ chainId: undefined });
    });

    // Hex out, like every other normalized request, whichever shape came in.
    it('normalizes a decimal chainId to hex', () => {
        expect(normalizeAddFundsParams([{ chainId: 8453 }])).toEqual({ chainId: '0x2105' });
    });

    it('passes a hex chainId through', () => {
        expect(normalizeAddFundsParams([{ chainId: '0x2105' }])).toEqual({ chainId: '0x2105' });
    });

    // The destination is the connected account. A dapp naming it could point the
    // QR at an address the user does not own, so the key is dropped, not honoured.
    it('ignores a dapp-supplied address', () => {
        const parsed = normalizeAddFundsParams([
            { address: '0x9999999999999999999999999999999999999999', chainId: 8453 },
        ]) as Record<string, unknown>;

        expect(parsed.address).toBeUndefined();
        expect(Object.keys(parsed)).toEqual(['chainId', 'chains']);
    });

    it('ignores any other unknown key', () => {
        expect(normalizeAddFundsParams([{ fiatAmount: '25', provider: 'coinbase' }])).toEqual({ chainId: undefined });
    });

    it('refuses a non-object parameter', () => {
        expect(() => normalizeAddFundsParams([42])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams({ chainId: 8453 })).toThrowError(invalidParams);
    });

    it('refuses a chainId that is not a positive integer', () => {
        expect(() => normalizeAddFundsParams([{ chainId: 0 }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chainId: -1 }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chainId: 1.5 }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chainId: 'base' }])).toThrowError(invalidParams);
    });

    // The stack shows what the dapp accepts, so the list has to survive
    // normalization in the order it was sent — the first entry is what the QR
    // falls back to when no chainId came with it.
    it('normalizes a chains list to hex, in order', () => {
        expect(normalizeAddFundsParams([{ chains: [8453, '0xa4b1'] }])).toEqual({
            chainId: undefined,
            chains: ['0x2105', '0xa4b1'],
        });
    });

    // A repeat would draw the same icon twice in the stack.
    it('deduplicates chains, including across hex spellings of one id', () => {
        expect(normalizeAddFundsParams([{ chains: [8453, '0x2105', '0x02105', 10] }])).toEqual({
            chainId: undefined,
            chains: ['0x2105', '0xa'],
        });
    });

    // Both keys are kept: one is where the QR points, the other is what the
    // stack offers, and a dapp that leads with a chain outside its own list is
    // telling us something contradictory that it should hear about — but that is
    // the signer's call, not the normalizer's.
    it('keeps chainId and chains together', () => {
        expect(normalizeAddFundsParams([{ chainId: 10, chains: [8453, 10] }])).toEqual({
            chainId: '0xa',
            chains: ['0x2105', '0xa'],
        });
    });

    // An empty list is a dapp whose filter matched nothing. Reading it as "no
    // preference" would answer that by showing every chain — the opposite.
    it('refuses an empty chains list', () => {
        expect(() => normalizeAddFundsParams([{ chains: [] }])).toThrowError(invalidParams);
    });

    it('refuses a chains value that is not an array', () => {
        expect(() => normalizeAddFundsParams([{ chains: 8453 }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chains: '0x2105' }])).toThrowError(invalidParams);
    });

    // A hole in an explicit list is a malformed entry, not an omitted option, so
    // it must not be skipped the way an absent top-level chainId is.
    // `JSON.stringify` raises on a BigInt, so before this a bigint chainId fell
    // through to the "got ${...}" throw and reached the dapp as an untyped
    // TypeError instead of -32602. Accepting it outright is the fix, matching
    // `optionalHexQuantity`, which has always taken one.
    it('accepts a bigint chainId rather than raising a TypeError', () => {
        expect(normalizeAddFundsParams([{ chainId: 8453n }])).toEqual({ chainId: '0x2105' });
        expect(normalizeAddFundsParams([{ chains: [8453n, 10n] }])).toEqual({
            chainId: undefined,
            chains: ['0x2105', '0xa'],
        });
    });

    it('refuses a non-positive bigint chainId', () => {
        expect(() => normalizeAddFundsParams([{ chainId: 0n }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chains: [-1n] }])).toThrowError(invalidParams);
    });

    // A circular object is the other value `JSON.stringify` raises on, and it
    // reaches the same message. The typed error has to survive being asked to
    // describe it.
    it('refuses an unserializable chainId with -32602, not a TypeError', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        expect(() => normalizeAddFundsParams([{ chainId: circular }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chains: [circular] }])).toThrowError(invalidParams);
    });

    it('refuses an invalid or empty entry inside chains', () => {
        expect(() => normalizeAddFundsParams([{ chains: [8453, null] }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chains: [8453, undefined] }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chains: [8453, 0] }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chains: ['base'] }])).toThrowError(invalidParams);
    });

    // A `chainId` outside the dapp's own `chains` would pin the QR to a chain
    // the same request says it does not accept, so the code and the row under
    // it would contradict each other.
    it('refuses a chainId that is not in chains', () => {
        expect(() => normalizeAddFundsParams([{ chainId: 11155111, chains: [1] }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chainId: 10, chains: [8453] }])).toThrowError(invalidParams);
    });

    // The two fields can spell one chain differently, so the check compares
    // values — refusing `0x01` against `0x1` would reject a coherent request.
    it('accepts a chainId in chains across hex spellings', () => {
        expect(normalizeAddFundsParams([{ chainId: '0x01', chains: ['0x1', 8453] }])).toEqual({
            chainId: '0x01',
            chains: ['0x1', '0x2105'],
        });
    });

    // Either alone is still fine: the contradiction needs both to be present.
    it('does not refuse chainId or chains sent on their own', () => {
        expect(() => normalizeAddFundsParams([{ chainId: 11155111 }])).not.toThrow();
        expect(() => normalizeAddFundsParams([{ chains: [11155111] }])).not.toThrow();
    });

    // '0x0' satisfied the hex-quantity shape, so it passed while `0` and `0n`
    // were refused. It then failed downstream as 5710 "set preference.showTestnets
    // to true", pointing the integrator at a setting that cannot help.
    it('refuses a zero chainId in every accepted shape', () => {
        expect(() => normalizeAddFundsParams([{ chainId: '0x0' }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chainId: '0x00' }])).toThrowError(invalidParams);
        expect(() => normalizeAddFundsParams([{ chains: ['0x0'] }])).toThrowError(invalidParams);
    });
});
