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
        expect(Object.keys(parsed)).toEqual(['chainId']);
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
});
