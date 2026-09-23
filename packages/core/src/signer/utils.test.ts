import { describe, it, expect, vi } from 'vitest';

import { createSigner } from './utils.js';
import type { UIHandler } from '../ui/interface.js';
import type { AppMetadata } from '../provider/index.js';

const metadata = { appName: 'Test', appLogoUrl: null, defaultChainId: 1 } as AppMetadata;
const uiHandler = { init: vi.fn() } as unknown as UIHandler;

describe('createSigner api-key requirement', () => {
    // The backend decides whether a keyless request is served, by the origin it
    // comes from. In app-specific mode that origin is the dApp's own page.
    it.each([undefined, ''])('builds an appSpecific signer with %p', (apiKey) => {
        expect(() =>
            createSigner({ signerType: 'appSpecific', metadata, uiHandler, callback: vi.fn(), apiKey })
        ).not.toThrow();
    });

    it('builds a crossPlatform signer with no key', () => {
        const communicator = { onMessage: vi.fn(), postMessage: vi.fn() } as never;

        expect(() =>
            createSigner({ signerType: 'crossPlatform', metadata, communicator, callback: vi.fn() })
        ).not.toThrow();
    });
});
