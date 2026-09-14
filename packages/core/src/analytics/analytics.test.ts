import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/index.js', () => ({ restCall: vi.fn().mockResolvedValue(undefined) }));

import { restCall } from '../api/index.js';
import { logAccountIssuance } from './index.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;

describe('logAccountIssuance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('records the issuance when there is a key to attribute it to', () => {
        logAccountIssuance({ address: ADDRESS, type: 'create', apiKey: 'k' });

        expect(vi.mocked(restCall)).toHaveBeenCalledOnce();
        expect(vi.mocked(restCall).mock.calls[0]?.[3]).toEqual({ 'x-api-key': 'k' });
    });

    // The endpoint authenticates on that header, so a call with no key is one the
    // server refuses. Sending it anyway spends a request to be told so, on a path
    // that is fire and forget and would swallow the answer.
    it('sends nothing when there is no key', () => {
        logAccountIssuance({ address: ADDRESS, type: 'create' });

        expect(vi.mocked(restCall)).not.toHaveBeenCalled();
    });
});
