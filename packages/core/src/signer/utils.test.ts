import { describe, it, expect, vi } from 'vitest';

import { createSigner } from './utils.js';
import type { UIHandler } from '../ui/interface.js';
import type { AppMetadata } from '../provider/index.js';

const metadata = { appName: 'Test', appLogoUrl: null, defaultChainId: 1 } as AppMetadata;
const uiHandler = { init: vi.fn() } as unknown as UIHandler;

describe('createSigner api-key requirement', () => {
    // App-specific mode hands the key straight to the dApp's own UIHandler, which
    // has nowhere to get one. An empty string is treated as absent here the same
    // way the URL builders do.
    it.each([undefined, ''])('refuses to build an appSpecific signer with %p', (apiKey) => {
        expect(() =>
            createSigner({ signerType: 'appSpecific', metadata, uiHandler, callback: vi.fn(), apiKey })
        ).toThrow('API key is required for appSpecific signer');
    });

    // This refusal comes back out of provider.request, where a dApp classifies by
    // error.code. A bare Error carries none, so it read as an unknown failure.
    it('refuses with a numeric code, like every other refusal on this path', () => {
        expect(() => createSigner({ signerType: 'appSpecific', metadata, uiHandler, callback: vi.fn() })).toThrow(
            expect.objectContaining({ code: expect.any(Number) })
        );
    });

    it('builds a crossPlatform signer with no key', () => {
        const communicator = { onMessage: vi.fn(), postMessage: vi.fn() } as never;

        expect(() =>
            createSigner({ signerType: 'crossPlatform', metadata, communicator, callback: vi.fn() })
        ).not.toThrow();
    });
});
