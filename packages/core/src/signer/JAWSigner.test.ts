import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Address } from 'viem';

import { JAWSigner } from './JAWSigner.js';
import { sdkstore } from '../store/index.js';
import { SDK_VERSION } from '../sdk-info.js';
import { logSignature } from '../analytics/index.js';
import type { ProviderEventCallback, RequestArguments } from '../provider/index.js';
import type { RPCResponse } from '../messages/index.js';
import type { WalletConnectResponse } from '../rpc/wallet_connect.js';

vi.mock('../analytics/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../analytics/index.js')>();
    return { ...actual, logSignature: vi.fn() };
});

/**
 * Minimal concrete signer to exercise the shared base-class request handling.
 * The abstract members (handshake / wallet_connect / signing) are not under
 * test here — only the silent authenticated read path (eth_accounts).
 */
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
    protected async handleSigningRequest(_request: RequestArguments): Promise<unknown> {
        return null;
    }
}

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;

function seedSession(account: { accounts?: Address[]; connectedAt?: number }, authTTL?: number) {
    sdkstore.setState(
        {
            chains: [],
            keys: {},
            account,
            config: { version: SDK_VERSION, preference: authTTL === undefined ? undefined : { authTTL } },
            callStatuses: {},
        },
        true
    );
}

function makeSigner(callback: ProviderEventCallback | null = null): TestSigner {
    return new TestSigner({ metadata: { name: 'test', defaultChainId: 1 } as never, callback });
}

const ethAccounts: RequestArguments = { method: 'eth_accounts' };

describe('JAWSigner eth_accounts (silent reconnect)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-16T00:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the cached accounts when the session is still within TTL', async () => {
        const connect = vi.fn();
        // connectedAt now, 1h TTL → live.
        seedSession({ accounts: [ACCOUNT], connectedAt: Date.now() }, 3600);
        const signer = makeSigner(connect);

        await expect(signer.request(ethAccounts)).resolves.toEqual([ACCOUNT]);
        // Silent reconnect still emits connect so the dApp can rehydrate.
        expect(connect).toHaveBeenCalledWith('connect', expect.anything());
    });

    it('returns an empty list (no prompt, no connect) when the session has expired', async () => {
        const connect = vi.fn();
        // connectedAt 2h ago, 1h TTL → expired.
        seedSession({ accounts: [ACCOUNT], connectedAt: Date.now() - 2 * 3600 * 1000 }, 3600);
        const signer = makeSigner(connect);

        await expect(signer.request(ethAccounts)).resolves.toEqual([]);
        // Must NOT silently re-attest a dead session.
        expect(connect).not.toHaveBeenCalled();
    });

    it('returns an empty list when caching is disabled (authTTL = 0)', async () => {
        seedSession({ accounts: [ACCOUNT], connectedAt: Date.now() }, 0);
        const signer = makeSigner();
        await expect(signer.request(ethAccounts)).resolves.toEqual([]);
    });
});

describe('JAWSigner signature analytics reporting', () => {
    const API_KEY = 'test-api-key';
    const SIGNER_ADDRESS = '0x2222222222222222222222222222222222222222' as Address;
    const SIGNABLE_TYPED_DATA = JSON.stringify({
        domain: { name: 'Test', version: '1', chainId: 1 },
        primaryType: 'Msg',
        types: {
            EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
            ],
            Msg: [{ name: 'content', type: 'string' }],
        },
        message: { content: 'hi' },
    });

    /** Signer whose signing outcome is scripted per test. */
    class SigningTestSigner extends TestSigner {
        signingResult: Promise<unknown> = Promise.resolve('0xsignature');
        protected override async handleSigningRequest(): Promise<unknown> {
            return this.signingResult;
        }
    }

    function seedAuthenticatedSession(apiKey?: string) {
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
    }

    function makeSigningSigner(): SigningTestSigner {
        return new SigningTestSigner({
            metadata: { name: 'test', defaultChainId: 1 } as never,
            callback: null,
        });
    }

    beforeEach(() => {
        vi.mocked(logSignature).mockClear();
    });

    it('reports a signature when personal_sign succeeds, using the address from params', async () => {
        // Given an authenticated session with an API key configured
        seedAuthenticatedSession(API_KEY);
        const signer = makeSigningSigner();

        // When a personal_sign request resolves successfully
        await signer.request({ method: 'personal_sign', params: ['0xdeadbeef', SIGNER_ADDRESS] });

        // Then the signature is reported with the signer address from params
        expect(logSignature).toHaveBeenCalledExactlyOnceWith({
            address: SIGNER_ADDRESS,
            apiKey: API_KEY,
        });
    });

    it('reports a signature when eth_signTypedData_v4 succeeds, using the address from params', async () => {
        // Given an authenticated session with an API key configured
        seedAuthenticatedSession(API_KEY);
        const signer = makeSigningSigner();

        // When an eth_signTypedData_v4 request resolves successfully
        await signer.request({
            method: 'eth_signTypedData_v4',
            // Must be genuinely signable: dispatchSigningRequest refuses typed data that
            // can't be hashed, so `{"types":{}}` no longer reaches the signing path.
            params: [SIGNER_ADDRESS, SIGNABLE_TYPED_DATA],
        });

        // Then the signature is reported with the signer address from params
        expect(logSignature).toHaveBeenCalledExactlyOnceWith({
            address: SIGNER_ADDRESS,
            apiKey: API_KEY,
        });
    });

    it('reports a signature for wallet_sign, falling back to the connected account when params omit the address', async () => {
        // Given an authenticated session with an API key configured
        seedAuthenticatedSession(API_KEY);
        const signer = makeSigningSigner();

        // When a wallet_sign request without an explicit address resolves
        await signer.request({
            method: 'wallet_sign',
            params: [{ request: { type: 'personal_sign', data: { message: 'hi' } } }],
        });

        // Then the signature is reported with the connected account address
        expect(logSignature).toHaveBeenCalledExactlyOnceWith({
            address: ACCOUNT,
            apiKey: API_KEY,
        });
    });

    it('does not report anything when the user rejects the signature', async () => {
        // Given an authenticated session and a signing flow that rejects
        seedAuthenticatedSession(API_KEY);
        const signer = makeSigningSigner();
        const rejection = new Error('User rejected the request');
        signer.signingResult = Promise.reject(rejection);

        // When the personal_sign request fails
        await expect(
            signer.request({ method: 'personal_sign', params: ['0xdeadbeef', SIGNER_ADDRESS] })
        ).rejects.toThrow(rejection);

        // Then no signature is reported
        expect(logSignature).not.toHaveBeenCalled();
    });

    it('does not report non-signature signing requests (wallet_sendCalls)', async () => {
        // Given an authenticated session with an API key configured
        seedAuthenticatedSession(API_KEY);
        const signer = makeSigningSigner();

        // When a wallet_sendCalls request resolves successfully
        await signer.request({
            method: 'wallet_sendCalls',
            params: [{ calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0x' }] }],
        });

        // Then no signature is reported
        expect(logSignature).not.toHaveBeenCalled();
    });

    it('reports without a key, which the backend resolves from the dApp origin', async () => {
        // Given an authenticated session with no API key
        seedAuthenticatedSession(undefined);
        const signer = makeSigningSigner();

        // When a personal_sign request resolves successfully
        const result = await signer.request({
            method: 'personal_sign',
            params: ['0xdeadbeef', SIGNER_ADDRESS],
        });

        // Then the signature is still reported, with no key to send
        expect(result).toBe('0xsignature');
        expect(logSignature).toHaveBeenCalledExactlyOnceWith({
            address: SIGNER_ADDRESS,
            apiKey: undefined,
        });
    });

    it('still returns the signature when reporting itself throws synchronously', async () => {
        // Given an authenticated session and a reporting pipeline that blows up
        seedAuthenticatedSession(API_KEY);
        const signer = makeSigningSigner();
        vi.mocked(logSignature).mockImplementationOnce(() => {
            throw new Error('analytics exploded');
        });

        // When a personal_sign request resolves successfully
        const result = await signer.request({
            method: 'personal_sign',
            params: ['0xdeadbeef', SIGNER_ADDRESS],
        });

        // Then the signing flow is unaffected by the reporting failure
        expect(result).toBe('0xsignature');
    });
});

describe('JAWSigner SIWE signature reporting (wallet_connect)', () => {
    const API_KEY = 'test-api-key';
    const SIWE_SUCCESS = { message: 'app.example wants you to sign in', signature: '0xsiwesig' as const };
    const SIWE_ERROR = { code: 4001, message: 'User rejected the request' };

    /** Exposes the protected fresh-response path a real signer feeds wallet_connect results through. */
    class ConnectTestSigner extends TestSigner {
        async deliverWalletConnectResponse(value: WalletConnectResponse): Promise<unknown> {
            const response: RPCResponse = { result: { value } };
            return this.handleResponse({ method: 'wallet_connect' }, response);
        }
    }

    function seedConfig(apiKey?: string) {
        sdkstore.setState(
            {
                chains: [],
                keys: {},
                account: {},
                config: { version: SDK_VERSION, apiKey },
                callStatuses: {},
            },
            true
        );
    }

    function makeConnectSigner(): ConnectTestSigner {
        return new ConnectTestSigner({ metadata: { name: 'test', defaultChainId: 1 } as never, callback: null });
    }

    beforeEach(() => {
        vi.mocked(logSignature).mockReset();
    });

    it('reports a signature when a fresh wallet_connect carries a successful SIWE capability', async () => {
        // Given an API key and a fresh connect whose SIWE capability resolved
        seedConfig(API_KEY);
        const signer = makeConnectSigner();

        // When the wallet_connect response is processed
        await signer.deliverWalletConnectResponse({
            accounts: [{ address: ACCOUNT, capabilities: { signInWithEthereum: SIWE_SUCCESS } }],
        });

        // Then the SIWE signature is reported for the connected account
        expect(logSignature).toHaveBeenCalledExactlyOnceWith({ address: ACCOUNT, apiKey: API_KEY });
    });

    it('does not report when the SIWE capability resolved to an error', async () => {
        // Given an API key and a connect whose SIWE capability failed
        seedConfig(API_KEY);
        const signer = makeConnectSigner();

        // When the wallet_connect response is processed
        await signer.deliverWalletConnectResponse({
            accounts: [{ address: ACCOUNT, capabilities: { signInWithEthereum: SIWE_ERROR } }],
        });

        // Then nothing is reported
        expect(logSignature).not.toHaveBeenCalled();
    });

    it('does not report a plain wallet_connect without a SIWE capability', async () => {
        // Given an API key and a connect without capabilities
        seedConfig(API_KEY);
        const signer = makeConnectSigner();

        // When the wallet_connect response is processed
        await signer.deliverWalletConnectResponse({ accounts: [{ address: ACCOUNT }] });

        // Then nothing is reported
        expect(logSignature).not.toHaveBeenCalled();
    });

    it('reports without a key, which the backend resolves from the dApp origin', async () => {
        // Given no API key and a connect with a successful SIWE capability
        seedConfig(undefined);
        const signer = makeConnectSigner();

        // When the wallet_connect response is processed
        const result = await signer.deliverWalletConnectResponse({
            accounts: [{ address: ACCOUNT, capabilities: { signInWithEthereum: SIWE_SUCCESS } }],
        });

        // Then the connect succeeds and the SIWE signature is still reported
        expect(result).toBeDefined();
        expect(logSignature).toHaveBeenCalledExactlyOnceWith({ address: ACCOUNT, apiKey: undefined });
    });
});

// The typed-data guard is dispatched per method by validateSigningRequest:
// eth_signTypedData_v4 always carries typed data; ERC-7871 wallet_sign only for
// request type 0x01 (0x45 is personal_sign). ReactUIHandler reshapes 0x01 into
// an eth_signTypedData_v4 dialog, so guarding only the former would leave the
// wallet_sign path unvalidated.
describe('JAWSigner typed-data validation dispatch', () => {
    /** Records whether the (would-be) dialog-opening signing path was reached. */
    class DispatchTestSigner extends TestSigner {
        signingRequests: RequestArguments[] = [];
        protected override async handleSigningRequest(request: RequestArguments): Promise<unknown> {
            this.signingRequests.push(request);
            return '0xsignature';
        }
    }

    const SIGNABLE = {
        domain: { name: 'Test', version: '1', chainId: 1 },
        primaryType: 'Msg',
        types: {
            EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
            ],
            Msg: [{ name: 'content', type: 'string' }],
        },
        message: { content: 'hi' },
    };
    const UNSIGNABLE = { primaryType: 'Permit', types: { Other: [] }, message: {} };

    const walletSign = (type: string, data: unknown): RequestArguments => ({
        method: 'wallet_sign',
        params: [{ address: ACCOUNT, request: { type, data } }],
    });

    function makeDispatchSigner(): DispatchTestSigner {
        seedSession({ accounts: [ACCOUNT], connectedAt: Date.now() });
        return new DispatchTestSigner({ metadata: { name: 'test', defaultChainId: 1 } as never, callback: null });
    }

    it('refuses an unsignable eth_signTypedData_v4 before the signing path runs', async () => {
        const signer = makeDispatchSigner();
        await expect(
            signer.request({ method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(UNSIGNABLE)] })
        ).rejects.toThrow(/"primaryType" "Permit" is not defined in "types"/);
        expect(signer.signingRequests).toHaveLength(0);
    });

    it('refuses an eth_signTypedData_v4 with no typed-data parameter', async () => {
        const signer = makeDispatchSigner();
        await expect(signer.request({ method: 'eth_signTypedData_v4', params: [ACCOUNT] })).rejects.toThrow(
            /typed data is required/
        );
    });

    it('passes a signable eth_signTypedData_v4 through to the signing path', async () => {
        const signer = makeDispatchSigner();
        await expect(
            signer.request({ method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(SIGNABLE)] })
        ).resolves.toBe('0xsignature');
        expect(signer.signingRequests).toHaveLength(1);
    });

    it('refuses an unsignable wallet_sign 0x01 payload', async () => {
        const signer = makeDispatchSigner();
        await expect(signer.request(walletSign('0x01', UNSIGNABLE))).rejects.toThrow(
            /"primaryType" "Permit" is not defined in "types"/
        );
        expect(signer.signingRequests).toHaveLength(0);
    });

    it('refuses a wallet_sign 0x01 with no typed data at all', async () => {
        const signer = makeDispatchSigner();
        await expect(signer.request(walletSign('0x01', undefined))).rejects.toThrow(/typed data is required/);
    });

    it('passes a signable wallet_sign 0x01 through to the signing path', async () => {
        const signer = makeDispatchSigner();
        await expect(signer.request(walletSign('0x01', SIGNABLE))).resolves.toBe('0xsignature');
    });

    it('leaves wallet_sign 0x45 (personal_sign) unguarded — it carries a message, not typed data', async () => {
        const signer = makeDispatchSigner();
        await expect(signer.request(walletSign('0x45', { message: 'hello' }))).resolves.toBe('0xsignature');
    });

    it('leaves a wallet_sign with no request object to the signing path', async () => {
        const signer = makeDispatchSigner();
        await expect(signer.request({ method: 'wallet_sign', params: [{}] })).resolves.toBe('0xsignature');
    });

    it('leaves personal_sign untouched by typed-data validation', async () => {
        const signer = makeDispatchSigner();
        await expect(signer.request({ method: 'personal_sign', params: ['0xdeadbeef', ACCOUNT] })).resolves.toBe(
            '0xsignature'
        );
    });
});
