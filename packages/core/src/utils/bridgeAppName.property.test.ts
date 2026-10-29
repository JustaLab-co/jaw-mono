import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { sanitizeBridgeAppName } from './bridgeAppName.js';

describe('sanitizeBridgeAppName', () => {
    it('leaves its own output unchanged and within the cap, for any input', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary' }), fc.integer({ min: 1, max: 80 }), (raw, cap) => {
                const once = sanitizeBridgeAppName(raw, cap);
                expect(sanitizeBridgeAppName(once, cap)).toBe(once);
                expect(Array.from(once).length).toBeLessThanOrEqual(cap);
            })
        );
    });
});
