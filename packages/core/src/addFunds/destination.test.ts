import { describe, expect, it } from 'vitest';
import { resolveDestination } from './destination.js';
import { standardErrorCodes } from '../errors/index.js';
import type { Address } from '../provider/interface.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const SECOND = '0x2222222222222222222222222222222222222222' as Address;

describe('resolveDestination', () => {
    it('returns the connected account', () => {
        expect(resolveDestination([ACCOUNT])).toBe(ACCOUNT);
    });

    it('returns the first account when several are connected', () => {
        expect(resolveDestination([ACCOUNT, SECOND])).toBe(ACCOUNT);
    });

    it('refuses to resolve a destination with no connected account', () => {
        expect(() => resolveDestination([])).toThrowError(
            expect.objectContaining({ code: standardErrorCodes.provider.unauthorized })
        );
    });
});
