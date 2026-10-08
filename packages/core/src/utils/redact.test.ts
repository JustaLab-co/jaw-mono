import { describe, it, expect } from 'vitest';
import { HttpRequestError } from 'viem';
import { withoutApiKey } from './redact.js';

describe('withoutApiKey', () => {
    it('masks the key in a viem error that prints its url', () => {
        const url = 'https://api.justaname.id/proxy/v1/rpc?chainId=1&api-key=secret-key&x=1';
        const text = withoutApiKey(new HttpRequestError({ url, status: 500 }));

        expect(text).not.toContain('secret-key');
        expect(text).toContain('api-key=***&x=1');
    });

    it('leaves text without a key as it was', () => {
        expect(withoutApiKey('rate limited')).toBe('rate limited');
    });
});
