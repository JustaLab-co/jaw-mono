import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Address } from 'viem';

import { JAWSigner } from './JAWSigner.js';
import { sdkstore } from '../store/index.js';
import { SDK_VERSION } from '../sdk-info.js';
import { handleGetAssetsRequest } from '../rpc/wallet_getAssets.js';
import { handleGetCallsHistoryRequest } from '../rpc/wallet_getCallsHistory.js';
import { handleGetPermissionsRequest, handleGetCapabilitiesRequest } from '../rpc/index.js';
import type { RequestArguments } from '../provider/index.js';

vi.mock('../rpc/wallet_getAssets.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../rpc/wallet_getAssets.js')>();
    return { ...actual, handleGetAssetsRequest: vi.fn().mockResolvedValue([]) };
});
vi.mock('../rpc/wallet_getCallsHistory.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../rpc/wallet_getCallsHistory.js')>();
    return { ...actual, handleGetCallsHistoryRequest: vi.fn().mockResolvedValue([]) };
});
vi.mock('../rpc/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../rpc/index.js')>();
    return {
        ...actual,
        handleGetPermissionsRequest: vi.fn().mockResolvedValue([]),
        handleGetCapabilitiesRequest: vi.fn().mockResolvedValue({}),
    };
});

/** Minimal concrete signer; only the authenticated read path is under test. */
class TestSigner extends JAWSigner {
    async handshake(): Promise<void> {
        /* not under test */
    }
    protected async handleWalletConnect(): Promise<unknown> {
        return null;
    }
    protected async handleWalletConnectUnauthenticated(): Promise<unknown> {
        return null;
    }
    protected async handleSigningRequest(): Promise<unknown> {
        return null;
    }
}

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;

function seedConnected(apiKey?: string) {
    sdkstore.setState(
        {
            chains: [],
            keys: {},
            account: { accounts: [ACCOUNT], connectedAt: Date.now() },
            config: { version: SDK_VERSION, apiKey },
            callStatuses: {},
        },
        true
    );
    return new TestSigner({ metadata: { name: 'test', defaultChainId: 1 } as never, callback: null });
}

// Third argument per method: the history and permission reads inject the
// connected account, the other two pass the testnet preference.
const reads = [
    { method: 'wallet_getCallsHistory', handler: vi.mocked(handleGetCallsHistoryRequest), third: ACCOUNT },
    { method: 'wallet_getAssets', handler: vi.mocked(handleGetAssetsRequest), third: false },
    { method: 'wallet_getPermissions', handler: vi.mocked(handleGetPermissionsRequest), third: ACCOUNT },
    { method: 'wallet_getCapabilities', handler: vi.mocked(handleGetCapabilitiesRequest), third: false },
] as const;

describe('JAWSigner proxy reads when no api-key is configured', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // These used to throw "No API key configured" before reaching the network.
    // Whether to serve a request is the backend's decision, so the absence has to
    // travel there for it to have a say. wallet_getCapabilities is the one that
    // matters most: it declares EIP-5792 atomic support, which is what an
    // interface gates one-click swaps on.
    for (const { method, handler, third } of reads) {
        const request = { method } as RequestArguments;

        it(`${method} forwards the missing key instead of refusing`, async () => {
            const signer = seedConnected(undefined);

            await expect(signer.request(request)).resolves.toBeDefined();
            expect(handler).toHaveBeenCalledWith(request, undefined, third);
        });

        it(`${method} still forwards a key when there is one`, async () => {
            const signer = seedConnected('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6');

            await signer.request(request);
            expect(handler).toHaveBeenCalledWith(request, 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', third);
        });
    }
});
