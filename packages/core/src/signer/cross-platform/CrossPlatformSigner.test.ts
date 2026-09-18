import { describe, it, expect, vi, beforeEach, afterEach, Mock, Mocked } from 'vitest';
import { CrossPlatformSigner } from './CrossPlatformSigner.js';
import { Communicator } from '../../communicator/index.js';
import { KeyManager } from '../../key-manager/index.js';
import { store } from '../../store/index.js';
import type { AppMetadata, ProviderEventCallback, RequestArguments } from '../../provider/interface.js';
import type { RPCResponseMessage, RPCResponse, RPCRequestMessage } from '../../messages/index.js';
import { exportKeyToHexString, importKeyFromHexString, encryptContent, decryptContent } from '../../utils/index.js';
import { fetchRPCRequest } from '../../utils/index.js';
import { correlationIds } from '../../store/correlation-ids/store.js';
import { getCallStatus, getCallStatusEIP5792 } from '../../rpc/wallet_sendCalls.js';
import { RECONNECT_REQUIRED } from '../../messages/index.js';
import { standardErrors, standardErrorCodes } from '../../errors/index.js';

// Mock dependencies
vi.mock('../../communicator/index.js', () => ({
    Communicator: vi.fn(() => ({
        waitForPopupLoaded: vi.fn(),
        postRequestAndWaitForResponse: vi.fn(),
        forceIframeReconnect: vi.fn(),
        disconnect: vi.fn(),
    })),
}));

vi.mock('../../key-manager/index.js', () => ({
    KeyManager: vi.fn(() => ({
        getOwnPublicKey: vi.fn(),
        setPeerPublicKey: vi.fn(),
        getSharedSecret: vi.fn(),
        clear: vi.fn(),
    })),
}));

vi.mock('../../utils/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../utils/index.js')>();
    return {
        ...actual,
        exportKeyToHexString: vi.fn(),
        importKeyFromHexString: vi.fn(),
        encryptContent: vi.fn(),
        decryptContent: vi.fn(),
        fetchRPCRequest: vi.fn(),
    };
});

vi.mock('../signerStorage.js', () => ({
    clearSignerType: vi.fn(),
}));

vi.mock('../../rpc/wallet_sendCalls.js', () => ({
    getCallStatus: vi.fn(),
    getCallStatusEIP5792: vi.fn(),
    waitForReceiptInBackground: vi.fn().mockResolvedValue(undefined),
    storeCallStatus: vi.fn(),
}));

const mockCryptoKey = {} as CryptoKey;
const mockEncryptedData = {
    iv: new Uint8Array([1, 2, 3]),
    cipherText: new ArrayBuffer(8),
};
const mockCorrelationId = 'test-correlation-id';
const mockMessageId = '12345678-1234-1234-1234-123456789012' as const;

describe('CrossPlatformSigner', () => {
    let signer: CrossPlatformSigner;
    let mockCommunicator: Mocked<Communicator>;
    let mockKeyManager: Mocked<KeyManager>;
    let mockCallback: ProviderEventCallback;
    let mockMetadata: AppMetadata;

    beforeEach(() => {
        // Setup metadata
        mockMetadata = {
            appName: 'Test App',
            appLogoUrl: 'https://test.com/logo.png',
            defaultChainId: 1,
        };

        // Setup mock communicator
        mockCommunicator = new Communicator({
            metadata: mockMetadata,
            preference: { keysUrl: 'https://test.com' },
        }) as Mocked<Communicator>;

        mockCommunicator.waitForPopupLoaded.mockResolvedValue({} as Window);
        mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue({
            id: mockMessageId,
            requestId: mockMessageId,
            correlationId: mockCorrelationId,
            sender: 'peer-public-key-hex',
            content: {
                encrypted: mockEncryptedData,
            },
            timestamp: new Date(),
        } as RPCResponseMessage);

        // Setup mock key manager
        mockKeyManager = new KeyManager({} as any) as Mocked<KeyManager>;
        (KeyManager as Mock).mockImplementation(() => mockKeyManager);

        mockKeyManager.getOwnPublicKey.mockResolvedValue(mockCryptoKey);
        mockKeyManager.setPeerPublicKey.mockResolvedValue(undefined);
        mockKeyManager.getSharedSecret.mockResolvedValue(mockCryptoKey);
        mockKeyManager.clear.mockResolvedValue(undefined);

        // Setup utility mocks
        (exportKeyToHexString as Mock).mockResolvedValue('mock-public-key-hex');
        (importKeyFromHexString as Mock).mockResolvedValue(mockCryptoKey);
        (encryptContent as Mock).mockResolvedValue(mockEncryptedData);
        (decryptContent as Mock).mockResolvedValue({
            result: { value: 'decrypted-value' },
        });
        (fetchRPCRequest as Mock).mockResolvedValue('rpc-result');

        // Setup correlation ID mock
        vi.spyOn(correlationIds, 'get').mockReturnValue(mockCorrelationId);

        // Setup callback
        mockCallback = vi.fn();

        // Setup store mocks
        vi.spyOn(store, 'getState').mockReturnValue({
            account: {
                accounts: [],
                chain: undefined,
                capabilities: undefined,
            },
            chains: [],
            config: {
                metadata: mockMetadata,
                version: '1.0.0',
            },
            keys: {},
            callStatuses: {},
        });

        vi.spyOn(store.config, 'get').mockReturnValue({
            metadata: mockMetadata,
            version: '1.0.0',
        });

        vi.spyOn(store.account, 'set').mockReturnValue(undefined);
        vi.spyOn(store.account, 'clear').mockReturnValue(undefined);
        vi.spyOn(store.chains, 'set').mockReturnValue(undefined);
        vi.spyOn(store.chains, 'clear').mockReturnValue(undefined);

        // Create signer instance
        signer = new CrossPlatformSigner({
            metadata: mockMetadata,
            communicator: mockCommunicator,
            callback: mockCallback,
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('Handshake', () => {
        it('should successfully perform handshake', async () => {
            // Arrange
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            // Mock decrypted response
            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                        137: { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
                    },
                    capabilities: {
                        '0x1': { paymasterService: { supported: true } },
                    },
                },
            } as RPCResponse);

            // Act
            await signer.handshake(handshakeRequest);

            // Assert
            expect(mockCommunicator.waitForPopupLoaded).toHaveBeenCalledWith('wallet_connect');
            expect(mockCommunicator.postRequestAndWaitForResponse).toHaveBeenCalled();

            const sentMessage = mockCommunicator.postRequestAndWaitForResponse.mock.calls[0][0] as any;
            expect(sentMessage.content).toHaveProperty('handshake');
            expect(sentMessage.content.handshake.method).toBe('wallet_connect');
        });

        it('should throw error if handshake response contains failure', async () => {
            // Arrange
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [],
            };

            const mockErrorResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    failure: {
                        code: 4001,
                        message: 'User rejected request',
                    },
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockErrorResponse);

            // Act & Assert
            await expect(signer.handshake(handshakeRequest)).rejects.toMatchObject({
                code: 4001,
                message: 'User rejected request',
            });
        });

        it('should store peer public key after successful handshake', async () => {
            // Arrange
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            // Act
            await signer.handshake(handshakeRequest);

            // Assert
            expect(importKeyFromHexString).toHaveBeenCalledWith('public', 'peer-public-key-hex');
        });
    });

    describe('Request After Handshake', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should successfully make eth_accounts request', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'eth_accounts',
            };

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toEqual(['0x1234567890123456789012345678901234567890']);
            expect(mockCallback).toHaveBeenCalledWith('connect', { chainId: '0x1' });
        });

        it('should successfully make eth_chainId request', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'eth_chainId',
            };

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe('0x1');
        });

        it('reconnects in the iframe and retries once on a reconnect-required failure (Safari)', async () => {
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const reconnectFailureResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: '',
                content: {
                    failure: {
                        code: 4900,
                        message: 'No session in this context; reconnect required',
                        data: { reason: RECONNECT_REQUIRED },
                    },
                },
                timestamp: new Date(),
            };

            const okResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: { encrypted: mockEncryptedData },
                timestamp: new Date(),
            };

            // 1) original request -> reconnect-required, 2) reconnect handshake -> ok,
            // 3) retried request -> ok
            mockCommunicator.postRequestAndWaitForResponse
                .mockResolvedValueOnce(reconnectFailureResponse)
                .mockResolvedValueOnce(okResponse)
                .mockResolvedValueOnce(okResponse);

            (decryptContent as Mock).mockResolvedValue({ result: { value: '0xsignature...' } } as RPCResponse);

            const result = await signer.request(request);

            expect(result).toBe('0xsignature...');
            // forced the reconnect at the iframe, exactly once
            expect(mockCommunicator.forceIframeReconnect).toHaveBeenCalledTimes(1);
            // re-keyed with the iframe session's public key
            expect(mockKeyManager.setPeerPublicKey).toHaveBeenCalled();
            // original + reconnect handshake + retry
            expect(mockCommunicator.postRequestAndWaitForResponse).toHaveBeenCalledTimes(3);
        });

        it('does not loop: a second reconnect-required after retry rejects', async () => {
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const reconnectFailureResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: '',
                content: {
                    failure: { code: 4900, message: 'reconnect', data: { reason: RECONNECT_REQUIRED } },
                },
                timestamp: new Date(),
            };
            const okHandshake: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: { encrypted: mockEncryptedData },
                timestamp: new Date(),
            };

            // original -> reconnect, handshake -> ok, retry -> reconnect AGAIN
            mockCommunicator.postRequestAndWaitForResponse
                .mockResolvedValueOnce(reconnectFailureResponse)
                .mockResolvedValueOnce(okHandshake)
                .mockResolvedValueOnce(reconnectFailureResponse);

            await expect(signer.request(request)).rejects.toMatchObject({ data: { reason: RECONNECT_REQUIRED } });
            // reconnect attempted only once (no infinite loop)
            expect(mockCommunicator.forceIframeReconnect).toHaveBeenCalledTimes(1);
        });

        it('does not reconnect on a normal (non-reconnect) failure', async () => {
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };
            const normalFailure: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: '',
                content: { failure: { code: 4001, message: 'User rejected' } },
                timestamp: new Date(),
            };
            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(normalFailure);

            await expect(signer.request(request)).rejects.toMatchObject({ code: 4001 });
            expect(mockCommunicator.forceIframeReconnect).not.toHaveBeenCalled();
        });

        it('should make personal_sign request to popup', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockSignResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockSignResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature...',
                },
            } as RPCResponse);

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe('0xsignature...');
            // Encrypted envelope → method-less ready, matching send-time routing.
            expect(mockCommunicator.waitForPopupLoaded).toHaveBeenCalledWith();
            expect(mockCommunicator.postRequestAndWaitForResponse).toHaveBeenCalled();
        });

        // addFunds signs nothing, so it has no per-method code here: it routes
        // like the signing methods and keys owns the screen. This pins that,
        // because a method missing from the routing switch fails as a 4200
        // unsupportedMethod rather than as a visible bug.
        it('routes wallet_addFunds to the popup and resolves what the popup returns', async () => {
            // Base configured, the way a dapp asking for Base would have it:
            // `validateSigningRequest` refuses a chainId the wallet does not
            // carry, and this file's default mock has `chains: []`.
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 8453 },
                    capabilities: undefined,
                },
                chains: [{ id: 8453, rpcUrl: 'https://base-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            } as never);

            const request: RequestArguments = { method: 'wallet_addFunds', params: [{ chainId: 8453 }] };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue({
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: { encrypted: mockEncryptedData },
                timestamp: new Date(),
            } as RPCResponseMessage);

            // Deposits land off-app, so the popup answers null rather than an order.
            (decryptContent as Mock).mockResolvedValue({ result: { value: null } } as RPCResponse);

            await expect(signer.request(request)).resolves.toBeNull();
            expect(mockCommunicator.postRequestAndWaitForResponse).toHaveBeenCalled();
        });

        // The dapp's raw envelope must not cross to keys: `validateSigningRequest`
        // normalizes addFunds now, and `handleSigningRequest` forwards the
        // normalized params, so unknown keys are dropped at the boundary. A
        // dapp-supplied `address` surviving this would be the whole point of
        // `resolveDestination` defeated, and nothing else pins it.
        it('forwards only the normalized envelope for wallet_addFunds, dropping a dapp-supplied address', async () => {
            // Base configured, the way a dapp asking for Base would have it:
            // `validateSigningRequest` refuses a chainId the wallet does not
            // carry, and this file's default mock has `chains: []`.
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 8453 },
                    capabilities: undefined,
                },
                chains: [{ id: 8453, rpcUrl: 'https://base-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            } as never);

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue({
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: { encrypted: mockEncryptedData },
                timestamp: new Date(),
            } as RPCResponseMessage);
            (decryptContent as Mock).mockResolvedValue({ result: { value: null } } as RPCResponse);

            await signer.request({
                method: 'wallet_addFunds',
                params: [{ chainId: 8453, address: '0x9999999999999999999999999999999999999999' }],
            });

            const sent = (encryptContent as Mock).mock.calls.at(-1)?.[0] as {
                action: { method: string; params: unknown[] };
            };
            expect(sent.action.method).toBe('wallet_addFunds');
            // Decimal in, hex out, and nothing else carried over.
            expect(sent.action.params).toEqual([{ chainId: '0x2105' }]);
        });

        // `optionalChainId` only proves the shape. Without this the QR pinned a
        // chain the wallet knows nothing about and where the account is not
        // deployed, while wallet_sendCalls refused the same value.
        //
        // 5710, from `resolveChain`: the same code and message every other
        // method gives for an unconfigured chain, rather than one written for
        // this method alone.
        it('refuses an unconfigured chainId before the popup opens', async () => {
            await expect(
                signer.request({ method: 'wallet_addFunds', params: [{ chainId: 1337 }] })
            ).rejects.toMatchObject({ code: standardErrorCodes.eip5792.unsupportedChainId });

            expect(mockCommunicator.postRequestAndWaitForResponse).not.toHaveBeenCalled();
        });

        // Closing the popup window rejects every in-flight request with 4001
        // (Communicator.awaitResponseOrClosed). addFunds has no reject action at
        // all — keys never calls onReject for it — so that 4001 is the window
        // dying, not a refusal, and the dapp should see the same null a Done
        // press gives rather than an error for the same intent.
        it('resolves null when the popup window closes during wallet_addFunds', async () => {
            mockCommunicator.postRequestAndWaitForResponse.mockRejectedValue(
                standardErrors.provider.userRejectedRequest('Request rejected')
            );

            await expect(signer.request({ method: 'wallet_addFunds' })).resolves.toBeNull();
        });

        // The same 4001 on a method that does have a reject action still throws,
        // so the mapping above is scoped rather than a blanket swallow.
        it('still rejects a signing method when the popup window closes', async () => {
            mockCommunicator.postRequestAndWaitForResponse.mockRejectedValue(
                standardErrors.provider.userRejectedRequest('Request rejected')
            );

            await expect(
                signer.request({
                    method: 'personal_sign',
                    params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
                })
            ).rejects.toMatchObject({ code: standardErrorCodes.provider.userRejectedRequest });
        });

        it('should make eth_sendTransaction request to popup', async () => {
            // Arrange
            const txRequest: RequestArguments = {
                method: 'eth_sendTransaction',
                params: [
                    {
                        from: '0x1234567890123456789012345678901234567890',
                        to: '0x0987654321098765432109876543210987654321',
                        value: '0x1000',
                        data: '0x',
                    },
                ],
            };

            const mockTxResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockTxResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xtxhash...',
                },
            } as RPCResponse);

            // Act
            const result = await signer.request(txRequest);

            // Assert
            expect(result).toBe('0xtxhash...');
            expect(mockCommunicator.postRequestAndWaitForResponse).toHaveBeenCalled();
        });

        it('should reject an eth_sendTransaction without `to` before opening a popup', async () => {
            // Arrange - previously this reached the popup, which rendered the
            // error and left the dapp's promise pending until the user closed it.
            const txRequest: RequestArguments = {
                method: 'eth_sendTransaction',
                params: [{ from: '0x1234567890123456789012345678901234567890', data: '0xdeadbeef' }],
            };

            // Act & Assert
            await expect(signer.request(txRequest)).rejects.toMatchObject({
                code: -32602,
                message: expect.stringContaining('to'),
            });
            expect(mockCommunicator.postRequestAndWaitForResponse).not.toHaveBeenCalled();
        });

        it('should switch chain successfully', async () => {
            // Arrange
            const switchRequest: RequestArguments = {
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x89' }], // Polygon
            };

            // Mock that chain is available
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 1 },
                    capabilities: undefined,
                },
                chains: [
                    { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
                ],
                config: {
                    metadata: mockMetadata,
                    version: '1.0.0',
                },
                keys: {},
                callStatuses: {},
            });

            // Act
            const result = await signer.request(switchRequest);

            // Assert
            expect(result).toBeNull();
            expect(store.account.set).toHaveBeenCalledWith({
                chain: { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
            });
            expect(mockCallback).toHaveBeenCalledWith('chainChanged', '0x89');
        });

        it('should handle wallet_getCallsStatus request', async () => {
            // Arrange
            const callsStatusRequest: RequestArguments = {
                method: 'wallet_getCallsStatus',
                params: ['0xbatchId'],
            };
            const mockCallStatus = { status: 'pending', chainId: 1 };
            const mockEIP5792Response = {
                version: '2.0.0',
                id: '0xbatchId' as `0x${string}`,
                chainId: '0x01' as `0x${string}`,
                status: 100, // pending
                atomic: true,
                receipts: undefined,
            };
            (getCallStatus as Mock).mockReturnValue(mockCallStatus);
            (getCallStatusEIP5792 as Mock).mockReturnValue(mockEIP5792Response);

            // Act
            const result = await signer.request(callsStatusRequest);

            // Assert
            expect(getCallStatusEIP5792).toHaveBeenCalledWith('0xbatchId');
            expect(result).toEqual(mockEIP5792Response);
        });

        it('should return status code 200 for completed status', async () => {
            // Arrange
            const callsStatusRequest: RequestArguments = {
                method: 'wallet_getCallsStatus',
                params: ['0xbatchId'],
            };
            const mockCallStatus = { status: 'completed', chainId: 1 };
            const mockEIP5792Response = {
                version: '2.0.0',
                id: '0xbatchId' as `0x${string}`,
                chainId: '0x01' as `0x${string}`,
                status: 200, // completed
                atomic: true,
                receipts: [
                    {
                        logs: [],
                        status: '0x1' as `0x${string}`,
                        blockHash: '0xhash' as `0x${string}`,
                        blockNumber: '0x123' as `0x${string}`,
                        gasUsed: '0x456' as `0x${string}`,
                        transactionHash: '0xreceipt1' as `0x${string}`,
                    },
                ],
            };
            (getCallStatus as Mock).mockReturnValue(mockCallStatus);
            (getCallStatusEIP5792 as Mock).mockReturnValue(mockEIP5792Response);

            // Act
            const result = await signer.request(callsStatusRequest);

            // Assert
            expect(result).toEqual(mockEIP5792Response);
        });

        it('should return status code 400 for failed status', async () => {
            // Arrange
            const callsStatusRequest: RequestArguments = {
                method: 'wallet_getCallsStatus',
                params: ['0xbatchId'],
            };
            const mockCallStatus = { status: 'failed', chainId: 1 };
            const mockEIP5792Response = {
                version: '2.0.0',
                id: '0xbatchId' as `0x${string}`,
                chainId: '0x01' as `0x${string}`,
                status: 400, // failed
                atomic: true,
                receipts: undefined,
            };
            (getCallStatus as Mock).mockReturnValue(mockCallStatus);
            (getCallStatusEIP5792 as Mock).mockReturnValue(mockEIP5792Response);

            // Act
            const result = await signer.request(callsStatusRequest);

            // Assert
            expect(result).toEqual(mockEIP5792Response);
        });

        it('should throw error if batchId is missing', async () => {
            // Arrange
            const callsStatusRequest: RequestArguments = {
                method: 'wallet_getCallsStatus',
                params: [],
            };

            // Act & Assert
            await expect(signer.request(callsStatusRequest)).rejects.toMatchObject({
                message: 'batchId is required',
            });
        });

        it('should throw error if no call status found', async () => {
            // Arrange
            const callsStatusRequest: RequestArguments = {
                method: 'wallet_getCallsStatus',
                params: ['0xnonexistent'],
            };
            (getCallStatus as Mock).mockReturnValue(undefined);
            (getCallStatusEIP5792 as Mock).mockReturnValue(undefined);

            // Act & Assert
            await expect(signer.request(callsStatusRequest)).rejects.toMatchObject({
                message: 'No call status found for batchId: 0xnonexistent',
            });
        });

        it('should forward unknown methods to RPC', async () => {
            // Arrange
            const rpcRequest: RequestArguments = {
                method: 'eth_getBalance',
                params: ['0x1234567890123456789012345678901234567890', 'latest'],
            };

            // Mock chain with RPC URL
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    capabilities: undefined,
                },
                chains: [{ id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            (fetchRPCRequest as Mock).mockResolvedValue('0x1000');

            // Act
            const result = await signer.request(rpcRequest);

            // Assert
            expect(result).toBe('0x1000');
            expect(fetchRPCRequest).toHaveBeenCalledWith(rpcRequest, 'https://eth-mainnet.rpc.com');
        });

        it('should throw unauthorized error for unauthenticated requests', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            // Act & Assert
            await expect(unauthenticatedSigner.request(request)).rejects.toThrow();
        });

        it('should handle error response from popup', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockErrorResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockErrorResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    error: {
                        code: 4001,
                        message: 'User rejected request',
                    },
                },
            });

            // Act & Assert
            await expect(signer.request(request)).rejects.toMatchObject({
                code: 4001,
                message: 'User rejected request',
            });
        });
    });

    describe('Cleanup', () => {
        it('should cleanup all resources', async () => {
            // Act
            await signer.cleanup();

            // Assert
            expect(store.account.clear).toHaveBeenCalled();
        });
    });

    describe('Integration: Handshake -> Request -> Cleanup', () => {
        it('should complete full flow successfully', async () => {
            // Step 1: Handshake
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Step 2: Make request
            const accountsRequest: RequestArguments = {
                method: 'eth_accounts',
            };

            const accounts = await signer.request(accountsRequest);
            expect(accounts).toEqual(['0x1234567890123456789012345678901234567890']);

            // Step 3: Cleanup
            await signer.cleanup();

            expect(store.account.clear).toHaveBeenCalled();
        });
    });

    describe('eth_requestAccounts Flow', () => {
        it('should trigger wallet_connect automatically when unauthenticated', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockWalletConnectResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockWalletConnectResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            // Act
            const result = await unauthenticatedSigner.request({
                method: 'eth_requestAccounts',
            });

            // Assert
            expect(result).toEqual(['0x1234567890123456789012345678901234567890']);
            // eth_requestAccounts routes through the wallet_connect flow when
            // unauthenticated, but that request is sent as an encrypted envelope,
            // which routes method-less — so the ready must be method-less too.
            expect(mockCommunicator.waitForPopupLoaded).toHaveBeenCalledWith();
            expect(mockCommunicator.postRequestAndWaitForResponse).toHaveBeenCalled();
        });

        it('should trigger accountsChanged callback after eth_requestAccounts', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockWalletConnectResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockWalletConnectResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            // Act
            await unauthenticatedSigner.request({
                method: 'eth_requestAccounts',
            });

            // Assert
            expect(mockCallback).toHaveBeenCalledWith('accountsChanged', [
                '0x1234567890123456789012345678901234567890',
            ]);
        });
    });

    describe('Simple RPC Methods', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should return first account for eth_coinbase', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'eth_coinbase',
            };

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe('0x1234567890123456789012345678901234567890');
        });

        it('should return chain id number for net_version', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'net_version',
            };

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe(1);
        });
    });

    describe('Error Handling: Critical Paths', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should throw error when forwarding to RPC without rpcUrl', async () => {
            // Arrange - Create new signer with chain that has no rpcUrl
            const signerWithNoRpc = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            // Set up authenticated state but with no rpcUrl
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 1 }, // No rpcUrl
                    capabilities: undefined,
                },
                chains: [{ id: 1 }], // No rpcUrl in chains either
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            // Manually set authenticated state for the signer
            (signerWithNoRpc as any).accounts = ['0x1234567890123456789012345678901234567890'];
            (signerWithNoRpc as any).chain = { id: 1 }; // No rpcUrl

            const rpcRequest: RequestArguments = {
                method: 'eth_getBalance',
                params: ['0x1234567890123456789012345678901234567890', 'latest'],
            };

            // Act & Assert
            await expect(signerWithNoRpc.request(rpcRequest)).rejects.toThrow('No RPC URL set for chain');
        });

        it('should throw error when encrypting without shared secret', async () => {
            // Arrange
            mockKeyManager.getSharedSecret.mockResolvedValue(null);

            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            // Act & Assert
            await expect(signer.request(request)).rejects.toThrow('No shared secret found when encrypting request');
        });

        it('should throw error when decrypting without shared secret', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockSignResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockSignResponse);

            // Mock shared secret to be null on decrypt (but present on encrypt)
            let encryptCallCount = 0;
            mockKeyManager.getSharedSecret.mockImplementation(async () => {
                encryptCallCount++;
                return encryptCallCount === 1 ? mockCryptoKey : null;
            });

            // Act & Assert
            await expect(signer.request(request)).rejects.toThrow(
                'Invalid session: no shared secret found when decrypting response'
            );
        });
    });

    describe('wallet_connect Caching', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Consume the pending wallet_connect response from handshake
            // so subsequent tests exercise the cached path
            await signer.request({ method: 'wallet_connect', params: [{ version: '1.0', capabilities: {} }] });

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should return cached wallet_connect response if available', async () => {
            // Arrange
            vi.spyOn(store.account, 'get').mockReturnValue({
                accounts: ['0x1234567890123456789012345678901234567890'],
                chain: { id: 1 },
                capabilities: undefined,
            });

            const request: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            // Act
            const result = await signer.request(request);

            // Assert - cached response returns address only, no capabilities
            expect(result).toEqual({
                accounts: [
                    {
                        address: '0x1234567890123456789012345678901234567890',
                    },
                ],
            });
            expect(mockCommunicator.postRequestAndWaitForResponse).not.toHaveBeenCalled();
        });

        it('should trigger connect callback when wallet_connect is not cached', async () => {
            // Arrange - Mock store to return undefined accounts (no cache)
            // Note: empty array [] is truthy, so getCachedWalletConnectResponse needs undefined
            vi.spyOn(store.account, 'get').mockReturnValue({
                accounts: undefined,
                chain: undefined,
                capabilities: undefined,
            });

            // Clear previous callback calls from beforeEach handshake
            vi.mocked(mockCallback).mockClear();

            const mockWalletConnectResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockWalletConnectResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            const request: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            // Act
            await signer.request(request);

            // Assert
            expect(mockCallback).toHaveBeenCalledWith('connect', { chainId: '0x1' });
        });
    });

    describe('Unauthenticated Scenarios', () => {
        it('should allow wallet_switchEthereumChain when unauthenticated if chain is supported', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            // Mock store with supported chains
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: undefined,
                    chain: undefined,
                    capabilities: undefined,
                },
                chains: [
                    { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
                ],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const request: RequestArguments = {
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x89' }],
            };

            // Act
            const result = await unauthenticatedSigner.request(request);

            // Assert - Should not throw and should update local chain
            expect(result).toBeNull();
        });

        it('should refuse eth_coinbase when the account list is empty', async () => {
            // Arrange - Create new signer without handshake, so accounts is []
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            // Act & Assert - The authenticated branch returns accounts[0], but
            // an empty list never reaches it: the request routes to the
            // unauthenticated branch, whose default refuses. So there is no
            // path where eth_coinbase resolves undefined.
            await expect(unauthenticatedSigner.request({ method: 'eth_coinbase' })).rejects.toMatchObject({
                code: 4100,
            });
        });

        it('should allow wallet_sendCalls when unauthenticated', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xbatchId',
                },
            } as RPCResponse);

            const request: RequestArguments = {
                method: 'wallet_sendCalls',
                params: [{ calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0x' }] }],
            };

            // Act
            const result = await unauthenticatedSigner.request(request);

            // Assert
            expect(result).toBe('0xbatchId');
            // Encrypted envelope → method-less ready, matching send-time routing.
            expect(mockCommunicator.waitForPopupLoaded).toHaveBeenCalledWith();
        });

        it('should forward a viem v2.0.0 wallet_sendCalls envelope to the popup', async () => {
            // Arrange - viem's sendCalls() default envelope: version '2.0.0',
            // hex chainId, atomicRequired, capabilities.
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: { encrypted: mockEncryptedData },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);
            (decryptContent as Mock).mockResolvedValue({
                result: { value: { id: '0xbatchId', chainId: 1 } },
            } as RPCResponse);

            // The v2.0.0 envelope carries a hex chainId, which the signer resolves
            // against the configured chains before routing to the popup.
            vi.spyOn(store, 'getState').mockReturnValue({
                account: { accounts: [], chain: undefined, capabilities: undefined },
                chains: [{ id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const request: RequestArguments = {
                method: 'wallet_sendCalls',
                params: [
                    {
                        atomicRequired: false,
                        calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0xdeadbeef' }],
                        capabilities: undefined,
                        chainId: '0x1',
                        from: '0x1234567890123456789012345678901234567890',
                        id: undefined,
                        version: '2.0.0',
                    },
                ],
            };

            // Act
            const result = await unauthenticatedSigner.request(request);

            // Assert
            expect(result).toEqual({ id: '0xbatchId', chainId: 1 });
            expect(mockCommunicator.postRequestAndWaitForResponse).toHaveBeenCalled();
        });

        it('should reject an unsupported wallet_sendCalls version with -32602 before opening a popup', async () => {
            // Arrange
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const request: RequestArguments = {
                method: 'wallet_sendCalls',
                params: [
                    {
                        version: '3.0.0',
                        calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0x' }],
                        chainId: '0x1',
                    },
                ],
            };

            // Act & Assert
            await expect(unauthenticatedSigner.request(request)).rejects.toMatchObject({
                code: -32602,
                message: expect.stringContaining('unsupported version'),
            });
            expect(mockCommunicator.postRequestAndWaitForResponse).not.toHaveBeenCalled();
        });

        it('should reject an unconfigured chain with EIP-5792 5710, not 4200', async () => {
            // Arrange - 4200 renders in viem as "the provider does not support
            // the requested method", which reads as a missing method rather
            // than a missing chain.
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            vi.spyOn(store, 'getState').mockReturnValue({
                account: { accounts: [], chain: undefined, capabilities: undefined },
                chains: [{ id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const request: RequestArguments = {
                method: 'wallet_sendCalls',
                params: [
                    {
                        version: '2.0.0',
                        chainId: '0x66eee', // Arbitrum Sepolia, not in `chains`
                        calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0x' }],
                    },
                ],
            };

            // Act & Assert
            await expect(unauthenticatedSigner.request(request)).rejects.toMatchObject({
                code: 5710,
                message: expect.stringContaining('showTestnets'),
            });
            expect(mockCommunicator.postRequestAndWaitForResponse).not.toHaveBeenCalled();
        });

        it('should honor a numeric chainId instead of falling back to the connected chain', async () => {
            // Arrange - params validation accepts a numeric chainId and hex-encodes
            // it, but the popup path only ever read a *string* chainId: dropping the
            // normalized envelope meant chain 421614 was ignored and the batch was
            // signed on whatever chain the wallet was connected to.
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            vi.spyOn(store, 'getState').mockReturnValue({
                account: { accounts: [], chain: undefined, capabilities: undefined },
                chains: [{ id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const request: RequestArguments = {
                method: 'wallet_sendCalls',
                params: [
                    {
                        version: '2.0.0',
                        chainId: 421614, // Arbitrum Sepolia as a number, not in `chains`
                        calls: [{ to: '0x0987654321098765432109876543210987654321', data: '0x' }],
                    },
                ],
            };

            // Act & Assert - refused as an unsupported chain, not silently redirected
            await expect(unauthenticatedSigner.request(request)).rejects.toMatchObject({
                code: 5710,
            });
            expect(mockCommunicator.postRequestAndWaitForResponse).not.toHaveBeenCalled();
        });

        it("should send keys the normalized envelope, not the dapp's raw one", async () => {
            // Arrange - a configured chain given as a number, plus a decimal wei
            // value: keys must receive both hex-encoded, matching what validation
            // approved and the chain resolved here.
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: { encrypted: mockEncryptedData },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);
            (decryptContent as Mock).mockResolvedValue({
                result: { value: { id: '0xbatchId', chainId: 1 } },
            } as RPCResponse);

            vi.spyOn(store, 'getState').mockReturnValue({
                account: { accounts: [], chain: undefined, capabilities: undefined },
                chains: [{ id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const request: RequestArguments = {
                method: 'wallet_sendCalls',
                params: [
                    {
                        version: '2.0.0',
                        chainId: 1,
                        from: '0x1234567890123456789012345678901234567890',
                        calls: [
                            {
                                to: '0x0987654321098765432109876543210987654321',
                                value: '1000000000000000',
                            },
                        ],
                    },
                ],
            };

            // Act
            await unauthenticatedSigner.request(request);

            // Assert
            expect(encryptContent).toHaveBeenCalledWith(
                {
                    action: {
                        method: 'wallet_sendCalls',
                        params: [
                            {
                                version: '2.0.0',
                                from: '0x1234567890123456789012345678901234567890',
                                chainId: '0x1',
                                atomicRequired: false,
                                calls: [
                                    {
                                        to: '0x0987654321098765432109876543210987654321',
                                        value: '0x38d7ea4c68000',
                                    },
                                ],
                            },
                        ],
                    },
                    chain: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                },
                mockCryptoKey
            );
        });

        it('should allow wallet_sign when unauthenticated', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature',
                },
            } as RPCResponse);

            // ERC-7871 wallet_sign format
            const request: RequestArguments = {
                method: 'wallet_sign',
                params: [{ request: { type: '0x45', data: { message: 'Hello' } } }],
            };

            // Act
            const result = await unauthenticatedSigner.request(request);

            // Assert
            expect(result).toBe('0xsignature');
            // Encrypted envelope → method-less ready, matching send-time routing.
            expect(mockCommunicator.waitForPopupLoaded).toHaveBeenCalledWith();
        });

        it('should allow wallet_connect when unauthenticated', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            const request: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            // Act
            const result = await unauthenticatedSigner.request(request);

            // Assert
            expect(result).toEqual({
                accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
            });
            // Unauthenticated wallet_connect is still sent as an encrypted
            // envelope → method-less ready, matching send-time routing.
            expect(mockCommunicator.waitForPopupLoaded).toHaveBeenCalledWith();
        });
    });

    describe('Chain & Capabilities Updates', () => {
        it('should update capabilities from response data', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                        137: { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
                    },
                    capabilities: {
                        '0x1': { paymasterService: { supported: true } },
                    },
                },
            } as RPCResponse);

            const request: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            // Act
            await unauthenticatedSigner.request(request);

            // Assert - chains are no longer stored from response data
            expect(store.chains.set).not.toHaveBeenCalled();
            expect(store.account.set).toHaveBeenCalledWith({
                capabilities: {
                    '0x1': { paymasterService: { supported: true } },
                },
            });
        });

        it('should not store chains from response data', async () => {
            // Arrange - Create new signer without handshake
            const unauthenticatedSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: {
                            id: 1,
                            rpcUrl: 'https://eth-mainnet.rpc.com',
                            nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimal: 18 },
                        },
                        137: {
                            id: 137,
                            rpcUrl: 'https://polygon-mainnet.rpc.com',
                            nativeCurrency: { name: 'Polygon', symbol: 'MATIC', decimal: 18 },
                        },
                    },
                },
            } as RPCResponse);

            const request: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            // Act
            await unauthenticatedSigner.request(request);

            // Assert - chains are no longer stored from response data
            expect(store.chains.set).not.toHaveBeenCalled();
        });
    });

    describe('updateChain Edge Cases', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                        137: { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should throw error when chain not found in available chains', async () => {
            // Arrange
            const switchRequest: RequestArguments = {
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x2a' }], // Chain 42 (not in available chains)
            };

            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    capabilities: undefined,
                },
                chains: [
                    { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
                ],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            // Act & Assert
            try {
                await signer.request(switchRequest);
                expect.fail('Should have thrown an error');
            } catch (error: any) {
                // 4902 (EIP-3326 unrecognized chain ID), not 4200 — wallet
                // libraries read 4902 to decide whether to offer
                // wallet_addEthereumChain.
                expect(error.code).toBe(4902);
                expect(error.message).toContain('42');
                expect(error.message).toContain('not configured');
            }
            expect(mockCommunicator.postRequestAndWaitForResponse).not.toHaveBeenCalled();
        });

        it('should not trigger chainChanged callback if chain is already current', async () => {
            // Arrange
            const switchRequest: RequestArguments = {
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x1' }], // Already on chain 1
            };

            const currentChain = { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' };

            // Set the signer's internal chain to the same object reference
            (signer as any).chain = currentChain;

            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: currentChain,
                    capabilities: undefined,
                },
                chains: [currentChain, { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            // Clear previous callback calls from beforeEach
            vi.mocked(mockCallback).mockClear();

            // Act
            const result = await signer.request(switchRequest);

            // Assert
            expect(result).toBeNull();
            expect(mockCallback).not.toHaveBeenCalled();
        });

        it('should not update chains when receiving chain data in responses', async () => {
            // Arrange
            // Mock current state with different chains
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    capabilities: undefined,
                },
                chains: [
                    { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    { id: 137, rpcUrl: 'https://polygon-mainnet.rpc.com' },
                ],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            // Clear previous callback calls
            vi.mocked(mockCallback).mockClear();

            // Act - Call updateChain through decryptResponseMessage by making a request
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature',
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                        10: { id: 10, rpcUrl: 'https://optimism-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.request(request);

            // Assert - chains are no longer stored from response data
            expect(store.chains.set).not.toHaveBeenCalled();
        });
    });

    describe('handleResponse Default Case', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should return result value for eth_signTypedData_v4', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'eth_signTypedData_v4',
                // Must be genuinely signable: dispatchSigningRequest refuses typed data
                // that can't be hashed, so `{"types":{}}` no longer reaches this path.
                params: [
                    '0x1234567890123456789012345678901234567890',
                    JSON.stringify({
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
                    }),
                ],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature123',
                },
            } as RPCResponse);

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe('0xsignature123');
            expect(store.account.set).not.toHaveBeenCalled(); // Should not update accounts
        });

        it('should throw unsupported method error for wallet_addEthereumChain', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'wallet_addEthereumChain',
                params: [{ chainId: '0xa', rpcUrls: ['https://optimism.rpc.com'] }],
            };

            // Act & Assert
            await expect(signer.request(request)).rejects.toMatchObject({
                code: 4200,
                message: 'The requested method is not supported by this Ethereum provider.',
            });
            expect(store.account.set).not.toHaveBeenCalled(); // Should not update accounts
        });

        it('should throw unsupported method error for wallet_watchAsset', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'wallet_watchAsset',
                params: [
                    {
                        type: 'ERC20',
                        options: {
                            address: '0xtoken',
                            symbol: 'TKN',
                            decimals: 18,
                        },
                    },
                ],
            };

            // Act & Assert
            await expect(signer.request(request)).rejects.toMatchObject({
                code: 4200,
                message: 'The requested method is not supported by this Ethereum provider.',
            });
            expect(store.account.set).not.toHaveBeenCalled();
        });
    });

    describe('decryptResponseMessage Edge Cases', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should handle response without chains data', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature',
                },
                data: undefined, // No data
            } as RPCResponse);

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe('0xsignature');
            expect(store.chains.set).not.toHaveBeenCalled();
        });

        it('should handle response without capabilities data', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature',
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                    // No capabilities
                },
            } as RPCResponse);

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe('0xsignature');
            expect(store.account.set).not.toHaveBeenCalledWith(
                expect.objectContaining({ capabilities: expect.anything() })
            );
        });

        it('should handle response with empty data object', async () => {
            // Arrange
            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature',
                },
                data: {}, // Empty data object
            } as RPCResponse);

            // Act
            const result = await signer.request(request);

            // Assert
            expect(result).toBe('0xsignature');
            expect(store.chains.set).not.toHaveBeenCalled();
        });
    });

    describe('Constructor Initialization', () => {
        it('should initialize with accounts from store', () => {
            // Arrange
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: [
                        '0x1111111111111111111111111111111111111111',
                        '0x2222222222222222222222222222222222222222',
                    ],
                    chain: { id: 137, rpcUrl: 'https://polygon.rpc.com' },
                    capabilities: undefined,
                },
                chains: [{ id: 137, rpcUrl: 'https://polygon.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            // Act
            const newSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            // Assert
            expect((newSigner as any).accounts).toEqual([
                '0x1111111111111111111111111111111111111111',
                '0x2222222222222222222222222222222222222222',
            ]);
            expect((newSigner as any).chain).toEqual({ id: 137, rpcUrl: 'https://polygon.rpc.com' });
        });

        it('should initialize with default chain when no accounts in store', () => {
            // Arrange
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: undefined,
                    chain: undefined,
                    capabilities: undefined,
                },
                chains: [],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const metadata: AppMetadata = {
                appName: 'Test App',
                appLogoUrl: 'https://test.com/logo.png',
                defaultChainId: 42,
            };

            // Act
            const newSigner = new CrossPlatformSigner({
                metadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            // Assert
            expect((newSigner as any).accounts).toEqual([]);
            expect((newSigner as any).chain).toEqual({ id: 42 }); // From defaultChainId
        });

        it('should initialize with chain 1 when no defaultChainId provided', () => {
            // Arrange
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: undefined,
                    chain: undefined,
                    capabilities: undefined,
                },
                chains: [],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const metadata: AppMetadata = {
                appName: 'Test App',
                appLogoUrl: 'https://test.com/logo.png',
                // No defaultChainId provided - should default to chain 1
            };

            // Act
            const newSigner = new CrossPlatformSigner({
                metadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            // Assert
            expect((newSigner as any).chain).toEqual({ id: 1 }); // Default to chain 1
        });
    });

    describe('createRequestMessage Structure', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should create request message with correlationId', async () => {
            // Arrange
            const testCorrelationId = 'test-correlation-123';
            vi.spyOn(correlationIds, 'get').mockReturnValue(testCorrelationId);

            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: testCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature',
                },
            } as RPCResponse);

            // Act
            await signer.request(request);

            // Assert
            const sentMessage = mockCommunicator.postRequestAndWaitForResponse.mock.calls[0][0] as RPCRequestMessage;
            expect(sentMessage.correlationId).toBe(testCorrelationId);
            expect(sentMessage.sender).toBe('mock-public-key-hex');
            expect(sentMessage.id).toBeDefined();
            expect(sentMessage.timestamp).toBeInstanceOf(Date);
            expect(sentMessage.content).toHaveProperty('encrypted');
        });

        it('should create handshake message with proper structure', async () => {
            // Arrange
            const newSigner = new CrossPlatformSigner({
                metadata: mockMetadata,
                communicator: mockCommunicator,
                callback: mockCallback,
            });

            const testCorrelationId = 'handshake-correlation-456';
            vi.spyOn(correlationIds, 'get').mockReturnValue(testCorrelationId);

            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: testCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            // Act
            await newSigner.handshake(handshakeRequest);

            // Assert
            const sentMessage = mockCommunicator.postRequestAndWaitForResponse.mock.calls[0][0] as RPCRequestMessage;
            expect(sentMessage.correlationId).toBe(testCorrelationId);
            expect(sentMessage.sender).toBe('mock-public-key-hex');
            expect(sentMessage.id).toBeDefined();
            expect(sentMessage.timestamp).toBeInstanceOf(Date);
            expect(sentMessage.content).toHaveProperty('handshake');
            expect((sentMessage.content as any).handshake.method).toBe('wallet_connect');
        });
    });

    describe('sendEncryptedRequest Structure', () => {
        beforeEach(async () => {
            // Perform handshake first
            const handshakeRequest: RequestArguments = {
                method: 'wallet_connect',
                params: [{ version: '1.0', capabilities: {} }],
            };

            const mockHandshakeResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockHandshakeResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: {
                        accounts: [{ address: '0x1234567890123456789012345678901234567890' }],
                    },
                },
                data: {
                    chains: {
                        1: { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    },
                },
            } as RPCResponse);

            await signer.handshake(handshakeRequest);

            // Reset mock call history
            vi.clearAllMocks();
        });

        it('should encrypt request with action and chainId', async () => {
            // Arrange
            // Mock store to have chains with rpcUrl
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 1 },
                    capabilities: undefined,
                },
                chains: [{ id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' }],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            const request: RequestArguments = {
                method: 'personal_sign',
                params: ['0x48656c6c6f', '0x1234567890123456789012345678901234567890'],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xsignature',
                },
            } as RPCResponse);

            // Act
            await signer.request(request);

            // Assert - message is decoded from hex '0x48656c6c6f' to 'Hello'
            expect(encryptContent).toHaveBeenCalledWith(
                {
                    action: {
                        method: 'personal_sign',
                        params: ['Hello', '0x1234567890123456789012345678901234567890'],
                    },
                    chain: {
                        id: 1,
                        rpcUrl: 'https://eth-mainnet.rpc.com',
                    },
                },
                mockCryptoKey
            );
        });

        it('should include current chainId in encrypted content', async () => {
            // Arrange - Switch to a different chain first
            vi.spyOn(store, 'getState').mockReturnValue({
                account: {
                    accounts: ['0x1234567890123456789012345678901234567890'],
                    chain: { id: 137, rpcUrl: 'https://polygon.rpc.com' },
                    capabilities: undefined,
                },
                chains: [
                    { id: 1, rpcUrl: 'https://eth-mainnet.rpc.com' },
                    { id: 137, rpcUrl: 'https://polygon.rpc.com' },
                ],
                config: { metadata: mockMetadata, version: '1.0.0' },
                keys: {},
                callStatuses: {},
            });

            await signer.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x89' }],
            });

            vi.clearAllMocks();

            const request: RequestArguments = {
                method: 'eth_sendTransaction',
                params: [
                    {
                        from: '0x1234567890123456789012345678901234567890',
                        to: '0x0987654321098765432109876543210987654321',
                        value: '0x100',
                    },
                ],
            };

            const mockResponse: RPCResponseMessage = {
                id: mockMessageId,
                requestId: mockMessageId,
                correlationId: mockCorrelationId,
                sender: 'peer-public-key-hex',
                content: {
                    encrypted: mockEncryptedData,
                },
                timestamp: new Date(),
            };

            mockCommunicator.postRequestAndWaitForResponse.mockResolvedValue(mockResponse);

            (decryptContent as Mock).mockResolvedValue({
                result: {
                    value: '0xtxhash',
                },
            } as RPCResponse);

            // Act
            await signer.request(request);

            // Assert
            expect(encryptContent).toHaveBeenCalledWith(
                {
                    action: request,
                    chain: {
                        id: 137,
                        rpcUrl: 'https://polygon.rpc.com',
                    }, // Should use the switched chain
                },
                mockCryptoKey
            );
        });
    });
});
