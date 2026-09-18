import { afterEach, describe, expect, it, vi } from 'vitest';

const restCall = vi.fn();
vi.mock('../api/index.js', () => ({ restCall: (...args: unknown[]) => restCall(...args) }));

import { logAccountIssuance, logSignature } from './index.js';

const ADDRESS = '0x6ca44a56b06869530c953dFa7868973be1456769';

// Both are fire and forget, so nothing downstream rejects what they send: a value
// that is not an address reached production and sat in the table as a row nothing
// could join.
describe('analytics against a value that is not an address', () => {
    afterEach(() => {
        restCall.mockReset();
    });

    it.each([
        ['junk', 'not-an-address'],
        ['a truncated address', '0xabc'],
        ['an empty string', ''],
        ['nothing at all', undefined],
    ])('sends no signature for %s', (_label, address) => {
        restCall.mockResolvedValue({});

        logSignature({ address: address as never });

        expect(restCall).not.toHaveBeenCalled();
    });

    it('sends no issuance for junk either', () => {
        restCall.mockResolvedValue({});

        logAccountIssuance({ address: 'not-an-address' as never, type: 'created' as never });

        expect(restCall).not.toHaveBeenCalled();
    });

    // Shape, not checksum: plenty of our own paths carry a lowercase address.
    it.each([
        ['checksummed', ADDRESS],
        ['lowercase', ADDRESS.toLowerCase()],
    ])('still sends a %s address', (_label, address) => {
        restCall.mockResolvedValue({});

        logSignature({ address: address as never });

        expect(restCall).toHaveBeenCalledTimes(1);
        expect(restCall.mock.calls[0][2]).toEqual({ address });
    });
});
