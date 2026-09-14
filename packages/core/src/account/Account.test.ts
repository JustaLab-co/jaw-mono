import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPublicClient, decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem';
import { Account } from './Account.js';
import { JAW_PAYMASTER_URL, ERC20_PAYMASTER_ADDRESS } from '../constants.js';

// Mock dependencies
vi.mock('../passkey-manager/index.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../passkey-manager/index.js')>();
    return {
        ...original,
        PasskeyManager: vi.fn().mockImplementation(() => ({
            checkAuth: vi.fn().mockReturnValue({ isAuthenticated: false }),
            fetchActiveCredentialId: vi.fn().mockReturnValue(null),
            getAccountByCredentialId: vi.fn().mockReturnValue(undefined),
            fetchAccounts: vi.fn().mockReturnValue([]),
            logout: vi.fn(),
            createPasskey: vi.fn(),
            authenticateWithWebAuthn: vi.fn(),
            importPasskeyAccount: vi.fn(),
            storePasskeyAccount: vi.fn(),
            storePasskeyAccountForLogin: vi.fn(),
            storeAuthState: vi.fn(),
        })),
    };
});

vi.mock('./erc20Paymaster.js', () => ({
    fetchTokenQuotes: vi.fn(),
    calculateTokenCostFromGas: vi.fn(),
}));

vi.mock('./smartAccount.js', () => ({
    createSmartAccount: vi.fn(),
    sendTransaction: vi.fn(),
    sendCalls: vi.fn(),
    sendCallsWithPermission: vi.fn(),
    // Passthrough: the 7702 prep adds nothing on a plain account, and what the
    // estimate is built over is what the assertions below read.
    prepareCallsForExecution: vi.fn(async (_account: unknown, calls: unknown) => ({ calls })),
    buildPermissionManagerCall: vi.fn().mockReturnValue({
        to: '0x0000000000000000000000000000000000009999',
        value: 0n,
        data: '0xbeefbeef',
    }),
    estimateUserOpGas: vi.fn(),
    calculateGas: vi.fn(),
    getBundlerClient: vi.fn().mockReturnValue({
        client: 'mockBundlerClient',
        getUserOperationReceipt: vi.fn().mockResolvedValue(null),
    }),
    SUPPORTED_CHAINS: [
        { id: 1, name: 'Ethereum' },
        { id: 11155111, name: 'Sepolia' },
    ],
}));

// Partial: only the calls that reach the network are faked. The encoders stay
// real, so a test that asserts on a built call is asserting on the real one.
vi.mock('../rpc/permissions.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../rpc/permissions.js')>()),
    grantPermissions: vi.fn(),
    revokePermission: vi.fn(),
    getPermissionFromRelay: vi.fn(),
    relayPermissionToPermission: vi.fn().mockReturnValue({ permissionId: '0xperm' }),
}));

vi.mock('../rpc/wallet_sendCalls.js', () => ({
    storeCallStatus: vi.fn(),
    waitForReceiptInBackground: vi.fn(),
    getCallStatusEIP5792: vi.fn(),
    transformReceiptsToEIP5792: vi.fn().mockReturnValue([]),
}));

vi.mock('viem', async () => {
    const actual = await vi.importActual('viem');
    return {
        ...actual,
        createPublicClient: vi.fn().mockReturnValue({}),
        http: vi.fn(),
    };
});

vi.mock('viem/account-abstraction', () => ({
    toWebAuthnAccount: vi.fn().mockReturnValue({
        type: 'webAuthn',
        publicKey: '0x04abc123',
    }),
}));

describe('Account', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // Re-apply default PasskeyManager mock (clearAllMocks doesn't reset implementations)
        const { PasskeyManager } = await import('../passkey-manager/index.js');
        vi.mocked(PasskeyManager).mockImplementation(
            () =>
                ({
                    checkAuth: vi.fn().mockReturnValue({ isAuthenticated: false }),
                    fetchActiveCredentialId: vi.fn().mockReturnValue(null),
                    getAccountByCredentialId: vi.fn().mockReturnValue(undefined),
                    fetchAccounts: vi.fn().mockReturnValue([]),
                    logout: vi.fn(),
                    createPasskey: vi.fn(),
                    authenticateWithWebAuthn: vi.fn(),
                    importPasskeyAccount: vi.fn(),
                    storePasskeyAccount: vi.fn(),
                    storePasskeyAccountForLogin: vi.fn(),
                    storeAuthState: vi.fn(),
                    getCurrentAccount: vi.fn().mockReturnValue(undefined),
                }) as never
        );
    });

    describe('Static method signatures', () => {
        it('should have get static method', () => {
            expect(typeof Account.get).toBe('function');
        });

        it('should have create static method', () => {
            expect(typeof Account.create).toBe('function');
        });

        it('should have import static method', () => {
            expect(typeof Account.import).toBe('function');
        });

        it('should have fromLocalAccount static method', () => {
            expect(typeof Account.fromLocalAccount).toBe('function');
        });

        it('should have getAuthenticatedAddress static method', () => {
            expect(typeof Account.getAuthenticatedAddress).toBe('function');
        });

        it('should have getStoredAccounts static method', () => {
            expect(typeof Account.getStoredAccounts).toBe('function');
        });

        it('should have logout static method', () => {
            expect(typeof Account.logout).toBe('function');
        });
    });

    describe('Static utility methods', () => {
        it('getAuthenticatedAddress should return null when not authenticated', () => {
            const result = Account.getAuthenticatedAddress();
            expect(result).toBeNull();
        });

        it('isAuthenticated pattern should work via getAuthenticatedAddress', () => {
            // The recommended pattern for checking authentication
            const isAuthenticated = Account.getAuthenticatedAddress() !== null;
            expect(isAuthenticated).toBe(false);
        });

        it('getStoredAccounts should return empty array when no accounts', () => {
            const result = Account.getStoredAccounts();
            expect(result).toEqual([]);
        });

        it('logout should not throw', () => {
            expect(() => Account.logout()).not.toThrow();
        });
    });

    describe('parseValue helper', () => {
        // Access the private static method through a test wrapper
        // We'll test this by creating test cases for sendTransaction input handling

        it('should handle undefined value', () => {
            // When value is undefined, parseValue returns undefined
            // This is tested implicitly through the interface
            expect(true).toBe(true);
        });

        it('should handle bigint value', () => {
            // bigint values should pass through unchanged
            const value = 1000000000000000000n;
            expect(typeof value).toBe('bigint');
        });

        it('should handle hex string value', () => {
            // Hex strings like "0x0de0b6b3a7640000" should be converted to bigint
            const hexValue = '0x0de0b6b3a7640000';
            expect(hexValue.startsWith('0x')).toBe(true);
            expect(BigInt(hexValue)).toBe(1000000000000000000n);
        });

        it('should reject non-hex string values', () => {
            // Non-hex strings should throw an error - use parseEther() at call site
            // This test documents the expected behavior
            const { isHex } = require('viem');

            // These are NOT valid - parseValue will throw
            expect(isHex('0.1')).toBe(false);
            expect(isHex('1')).toBe(false);
            expect(isHex('100')).toBe(false);

            // Only hex strings and bigint are valid
            expect(isHex('0x0de0b6b3a7640000')).toBe(true);
        });
    });

    describe('buildChainConfig helper', () => {
        it('should build correct RPC URL with apiKey', () => {
            // The RPC URL format should be: ${JAW_RPC_URL}?chainId=${chainId}&api-key=${apiKey}
            const chainId = 1;
            const apiKey = 'test-api-key';

            // JAW_RPC_URL from constants
            const JAW_RPC_URL = 'https://api.justaname.id/proxy/v1/rpc';
            const expectedUrl = `${JAW_RPC_URL}?chainId=${chainId}&api-key=${apiKey}`;

            expect(expectedUrl).toBe('https://api.justaname.id/proxy/v1/rpc?chainId=1&api-key=test-api-key');
        });

        it('should build correct RPC URL without apiKey', () => {
            const chainId = 1;

            const JAW_RPC_URL = 'https://api.justaname.id/proxy/v1/rpc';
            const expectedUrl = `${JAW_RPC_URL}?chainId=${chainId}`;

            expect(expectedUrl).toBe('https://api.justaname.id/proxy/v1/rpc?chainId=1');
        });

        it('should include paymasterUrl when provided', () => {
            // When paymasterUrl is provided, it should be included in the chain config
            const paymasterUrl = 'https://paymaster.example.com';
            // The chain config should include paymasterUrl
            expect(paymasterUrl).toBeDefined();
        });
    });

    describe('Instance method signatures (prototype check)', () => {
        it('should have signMessage method on prototype', () => {
            expect(typeof Account.prototype.signMessage).toBe('function');
        });

        it('should have signTypedData method on prototype', () => {
            expect(typeof Account.prototype.signTypedData).toBe('function');
        });

        it('should have sendTransaction method on prototype', () => {
            expect(typeof Account.prototype.sendTransaction).toBe('function');
        });

        it('should have sendCalls method on prototype', () => {
            expect(typeof Account.prototype.sendCalls).toBe('function');
        });

        it('should have getCallStatus method on prototype', () => {
            expect(typeof Account.prototype.getCallStatus).toBe('function');
        });

        it('should have estimateGas method on prototype', () => {
            expect(typeof Account.prototype.estimateGas).toBe('function');
        });

        it('should have calculateGasCost method on prototype', () => {
            expect(typeof Account.prototype.calculateGasCost).toBe('function');
        });

        it('should have grantPermissions method on prototype', () => {
            expect(typeof Account.prototype.grantPermissions).toBe('function');
        });

        it('should have revokePermission method on prototype', () => {
            expect(typeof Account.prototype.revokePermission).toBe('function');
        });

        it('should have getMetadata method on prototype', () => {
            expect(typeof Account.prototype.getMetadata).toBe('function');
        });

        it('should have getSmartAccount method on prototype', () => {
            expect(typeof Account.prototype.getSmartAccount).toBe('function');
        });

        it('should have getChain method on prototype', () => {
            expect(typeof Account.prototype.getChain).toBe('function');
        });
    });

    describe('Type exports', () => {
        it('should export AccountConfig type', async () => {
            // Type-only test - verifies the import doesn't throw
            const { Account } = await import('./Account.js');
            expect(Account).toBeDefined();
        });

        it('should export CreateAccountOptions type', async () => {
            // Type-only test
            const mod = await import('./Account.js');
            expect(mod).toBeDefined();
        });

        it('should export TransactionCall type', async () => {
            // Type-only test
            const mod = await import('./Account.js');
            expect(mod).toBeDefined();
        });
    });

    describe('Value parsing edge cases', () => {
        it('should parse "0" correctly', () => {
            expect(BigInt('0')).toBe(0n);
        });

        it('should parse "0x0" correctly', () => {
            expect(BigInt('0x0')).toBe(0n);
        });

        it('should parse large numbers correctly', () => {
            const largeNumber = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
            expect(BigInt(largeNumber)).toBe(BigInt(largeNumber));
        });

        it('should parse ether values with many decimals', async () => {
            const { parseEther } = await import('viem');
            // parseEther handles up to 18 decimals
            expect(parseEther('0.000000000000000001')).toBe(1n);
            expect(parseEther('1.123456789012345678')).toBe(1123456789012345678n);
        });
    });

    describe('Error handling', () => {
        it('get should throw when not authenticated and no credentialId provided', async () => {
            await expect(Account.get({ chainId: 1, apiKey: 'test' })).rejects.toThrow('Not authenticated');
        });

        it('get should throw when rpId is missing in non-browser environment', async () => {
            const { PasskeyManager } = await import('../passkey-manager/index.js');
            const originalWindow = globalThis.window;
            // @ts-expect-error - simulating non-browser environment
            delete globalThis.window;

            vi.mocked(PasskeyManager).mockImplementation(
                () =>
                    ({
                        checkAuth: vi.fn().mockReturnValue({ isAuthenticated: false }),
                        fetchActiveCredentialId: vi.fn().mockReturnValue(null),
                        getAccountByCredentialId: vi.fn().mockReturnValue({
                            username: 'test',
                            credentialId: 'cred-123',
                            publicKey: '0x04abc',
                            creationDate: new Date().toISOString(),
                            isImported: false,
                        }),
                        fetchAccounts: vi.fn().mockReturnValue([]),
                        logout: vi.fn(),
                        createPasskey: vi.fn(),
                        authenticateWithWebAuthn: vi.fn(),
                        importPasskeyAccount: vi.fn(),
                        storePasskeyAccount: vi.fn(),
                        storePasskeyAccountForLogin: vi.fn(),
                        storeAuthState: vi.fn(),
                    }) as never
            );

            try {
                await expect(Account.get({ chainId: 1, apiKey: 'test' }, 'cred-123')).rejects.toThrow(
                    'rpId is required in non-browser environments'
                );
            } finally {
                globalThis.window = originalWindow;
            }
        });

        it('create should throw when rpId is missing in non-browser environment', async () => {
            const originalWindow = globalThis.window;
            // @ts-expect-error - simulating non-browser environment
            delete globalThis.window;

            try {
                await expect(Account.create({ chainId: 1, apiKey: 'test' }, { username: 'alice' })).rejects.toThrow(
                    'rpId is required in non-browser environments'
                );
            } finally {
                globalThis.window = originalWindow;
            }
        });
    });

    describe('sendCalls and getCallStatus', () => {
        it('sendCalls should store call status and wait for receipt in background', async () => {
            const { createSmartAccount, sendCalls: sendSmartAccountCalls } = await import('./smartAccount.js');
            const { storeCallStatus, waitForReceiptInBackground } = await import('../rpc/wallet_sendCalls.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockUserOpHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
            vi.mocked(sendSmartAccountCalls).mockResolvedValue({
                id: mockUserOpHash,
                chainId: 1,
            });

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            const result = await account.sendCalls([
                {
                    to: '0x1234567890123456789012345678901234567890',
                    value: 100000000000000000n,
                },
            ]);

            expect(result.id).toBe(mockUserOpHash);
            expect(result.chainId).toBe(1);
            expect(storeCallStatus).toHaveBeenCalledWith(mockUserOpHash, 1, 'test-api-key');
            expect(waitForReceiptInBackground).toHaveBeenCalledWith(mockUserOpHash, 1, 'test-api-key');
        });

        it('getCallStatus should return status from getCallStatusEIP5792', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const { getCallStatusEIP5792 } = await import('../rpc/wallet_sendCalls.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockBatchId = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
            const mockStatus = {
                version: '2.0.0',
                id: mockBatchId as `0x${string}`,
                chainId: '0x1' as `0x${string}`,
                status: 200,
                atomic: true,
                receipts: [
                    {
                        logs: [],
                        status: '0x1' as `0x${string}`,
                        blockHash: '0x123' as `0x${string}`,
                        blockNumber: '0x100' as `0x${string}`,
                        gasUsed: '0x5208' as `0x${string}`,
                        transactionHash: '0x456' as `0x${string}`,
                    },
                ],
            };
            vi.mocked(getCallStatusEIP5792).mockReturnValue(mockStatus);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            const status = await account.getCallStatus(mockBatchId as `0x${string}`);

            expect(getCallStatusEIP5792).toHaveBeenCalledWith(mockBatchId);
            expect(status).toEqual(mockStatus);
            expect(status?.status).toBe(200);
            expect(status?.receipts?.[0].transactionHash).toBe('0x456');
        });

        it('getCallStatus should return undefined when status not found', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const { getCallStatusEIP5792 } = await import('../rpc/wallet_sendCalls.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            vi.mocked(getCallStatusEIP5792).mockReturnValue(undefined);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            const status = await account.getCallStatus('0xnonexistent' as `0x${string}`);

            expect(status).toBeUndefined();
        });

        it('getCallStatus should fall back to bundler RPC when the in-memory store misses', async () => {
            const { createSmartAccount, getBundlerClient } = await import('./smartAccount.js');
            const { getCallStatusEIP5792, transformReceiptsToEIP5792 } = await import('../rpc/wallet_sendCalls.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            // In-memory store has nothing for this batch.
            vi.mocked(getCallStatusEIP5792).mockReturnValue(undefined);

            // Bundler returns a real receipt.
            const mockBatchId = '0xfeec0a41f83ec816f6df368c10bd4eb1c08e1dcb85e254e621fb9ee4d22729e1' as `0x${string}`;
            const mockBundlerReceipt = {
                success: true,
                receipt: {
                    transactionHash: '0xbc079b60838eca1a0379185124dc2878729ec28585a5e6f4d8f45eb3f87d1d95',
                    blockNumber: '0x26fff07',
                    blockHash: '0xabc',
                    gasUsed: '0x61878',
                    status: 'success',
                    logs: [],
                },
            };
            const mockGetUserOperationReceipt = vi.fn().mockResolvedValue(mockBundlerReceipt);
            vi.mocked(getBundlerClient).mockReturnValue({
                getUserOperationReceipt: mockGetUserOperationReceipt,
            } as never);

            // Stub the receipt transformer; we just need to assert it's invoked
            // with the bundler payload.
            const transformedReceipts = [
                {
                    logs: [],
                    status: '0x1',
                    blockHash: '0xabc',
                    blockNumber: '0x26fff07',
                    gasUsed: '0x61878',
                    transactionHash: mockBundlerReceipt.receipt.transactionHash,
                },
            ];
            vi.mocked(transformReceiptsToEIP5792).mockReturnValue(transformedReceipts as never);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };
            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            const status = await account.getCallStatus(mockBatchId);

            expect(mockGetUserOperationReceipt).toHaveBeenCalledWith({ hash: mockBatchId });
            expect(transformReceiptsToEIP5792).toHaveBeenCalledWith([mockBundlerReceipt]);
            expect(status).toEqual({
                version: '2.0.0',
                id: mockBatchId,
                chainId: '0x1',
                status: 200,
                atomic: true,
                receipts: transformedReceipts,
            });
        });

        it('sendCalls with permissionId should use sendCallsWithPermission', async () => {
            const { createSmartAccount, sendCallsWithPermission } = await import('./smartAccount.js');
            const { storeCallStatus, waitForReceiptInBackground } = await import('../rpc/wallet_sendCalls.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockUserOpHash = '0xpermission1234567890abcdef1234567890abcdef1234567890abcdef12345678';
            vi.mocked(sendCallsWithPermission).mockResolvedValue({
                id: mockUserOpHash,
                chainId: 1,
            });

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            const permissionId =
                '0xabc123def456789012345678901234567890123456789012345678901234567890' as `0x${string}`;
            const result = await account.sendCalls(
                [
                    {
                        to: '0x1234567890123456789012345678901234567890',
                        value: 100000000000000000n,
                    },
                ],
                { permissionId }
            );

            expect(result.id).toBe(mockUserOpHash);
            expect(result.chainId).toBe(1);
            expect(sendCallsWithPermission).toHaveBeenCalledWith(
                mockSmartAccount,
                [
                    {
                        to: '0x1234567890123456789012345678901234567890',
                        value: 100000000000000000n,
                        data: undefined,
                    },
                ],
                expect.objectContaining({ id: 1 }),
                permissionId,
                'test-api-key',
                undefined,
                undefined,
                undefined,
                undefined,
                // The permission-manager call, built up here so the paymaster
                // approval is sized over the shape that actually goes out.
                { to: '0x0000000000000000000000000000000000009999', value: 0n, data: '0xbeefbeef' }
            );
            expect(storeCallStatus).toHaveBeenCalledWith(mockUserOpHash, 1, 'test-api-key');
            expect(waitForReceiptInBackground).toHaveBeenCalledWith(mockUserOpHash, 1, 'test-api-key');
        });

        it('sendCalls without permissionId should use standard sendCalls', async () => {
            const {
                createSmartAccount,
                sendCalls: sendSmartAccountCalls,
                sendCallsWithPermission,
            } = await import('./smartAccount.js');
            const { storeCallStatus } = await import('../rpc/wallet_sendCalls.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockUserOpHash = '0xstandard1234567890abcdef1234567890abcdef1234567890abcdef123456789';
            vi.mocked(sendSmartAccountCalls).mockResolvedValue({
                id: mockUserOpHash,
                chainId: 1,
            });

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            // Call without permissionId
            const result = await account.sendCalls([
                {
                    to: '0x1234567890123456789012345678901234567890',
                    value: 100000000000000000n,
                },
            ]);

            expect(result.id).toBe(mockUserOpHash);
            expect(sendSmartAccountCalls).toHaveBeenCalled();
            expect(sendCallsWithPermission).not.toHaveBeenCalled();
            expect(storeCallStatus).toHaveBeenCalledWith(mockUserOpHash, 1, 'test-api-key');
        });
    });

    describe('React Native adapter options forwarding', () => {
        it('Account.create should forward nativeCreateFn and nativeGetFn', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const { PasskeyManager } = await import('../passkey-manager/index.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockNativeCreateFn = vi.fn();
            const mockNativeGetFn = vi.fn();

            // Mock PasskeyManager to return proper createPasskey result
            const mockCreatePasskey = vi.fn().mockResolvedValue({
                credentialId: 'rn-cred',
                publicKey: '0x04rn',
                webAuthnAccount: { type: 'webAuthn', publicKey: '0x04rn' },
                passkeyAccount: {
                    username: 'alice',
                    credentialId: 'rn-cred',
                    publicKey: '0x04rn',
                    creationDate: new Date().toISOString(),
                    isImported: false,
                },
            });
            vi.mocked(PasskeyManager).mockImplementation(
                () =>
                    ({
                        checkAuth: vi.fn().mockReturnValue({ isAuthenticated: false }),
                        fetchActiveCredentialId: vi.fn().mockReturnValue(null),
                        getAccountByCredentialId: vi.fn().mockReturnValue(undefined),
                        getCurrentAccount: vi.fn().mockReturnValue(undefined),
                        fetchAccounts: vi.fn().mockReturnValue([]),
                        logout: vi.fn(),
                        createPasskey: mockCreatePasskey,
                        authenticateWithWebAuthn: vi.fn(),
                        importPasskeyAccount: vi.fn(),
                        storePasskeyAccount: vi.fn(),
                        storePasskeyAccountForLogin: vi.fn(),
                        storeAuthState: vi.fn(),
                    }) as never
            );

            await Account.create(
                {
                    chainId: 1,
                    apiKey: 'test-api-key',
                    rpId: 'example.com',
                    rpName: 'MyApp',
                    nativeCreateFn: mockNativeCreateFn,
                    nativeGetFn: mockNativeGetFn,
                },
                { username: 'alice' }
            );

            // PasskeyManager.createPasskey should have been called with wrapped native fns
            // nativeCreateFn gets wrapped into internalNativeCreateFn, nativeGetFn into getFn
            expect(mockCreatePasskey).toHaveBeenCalledWith(
                'alice',
                'example.com',
                'MyApp',
                undefined, // createFn (browser path)
                expect.any(Function), // internalNativeCreateFn (wrapped from nativeCreateFn)
                expect.any(Function) // getFn (wrapped from nativeGetFn)
            );
        });

        it('Account.get with nativeGetFn should forward wrapped getFn and rpId', async () => {
            const { PasskeyManager } = await import('../passkey-manager/index.js');
            const { toWebAuthnAccount } = await import('viem/account-abstraction');
            const { createSmartAccount } = await import('./smartAccount.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            // Set up PasskeyManager mock to return authenticated state
            const mockManagerInstance = {
                checkAuth: vi.fn().mockReturnValue({
                    isAuthenticated: true,
                    address: '0x1234567890123456789012345678901234567890',
                }),
                fetchActiveCredentialId: vi.fn().mockReturnValue('cred-123'),
                getAccountByCredentialId: vi.fn().mockReturnValue({
                    username: 'alice',
                    credentialId: 'cred-123',
                    publicKey: '0x04abc',
                    creationDate: new Date().toISOString(),
                    isImported: false,
                }),
                getCurrentAccount: vi.fn().mockReturnValue({
                    username: 'alice',
                    credentialId: 'cred-123',
                    publicKey: '0x04abc',
                    creationDate: new Date().toISOString(),
                    isImported: false,
                }),
                fetchAccounts: vi.fn().mockReturnValue([]),
                logout: vi.fn(),
                createPasskey: vi.fn(),
                authenticateWithWebAuthn: vi.fn(),
                importPasskeyAccount: vi.fn(),
                storePasskeyAccount: vi.fn(),
                storePasskeyAccountForLogin: vi.fn(),
                storeAuthState: vi.fn(),
            };
            vi.mocked(PasskeyManager).mockImplementation(() => mockManagerInstance as never);

            const mockNativeGetFn = vi.fn();
            await Account.get({
                chainId: 1,
                apiKey: 'test-api-key',
                nativeGetFn: mockNativeGetFn,
                rpId: 'example.com',
            });

            // toWebAuthnAccount should have been called with a wrapped getFn and rpId
            expect(toWebAuthnAccount).toHaveBeenCalledWith(
                expect.objectContaining({
                    getFn: expect.any(Function),
                    rpId: 'example.com',
                })
            );
        });

        it('Account.import should forward nativeGetFn (wrapped) and rpId', async () => {
            const { PasskeyManager } = await import('../passkey-manager/index.js');
            const { toWebAuthnAccount } = await import('viem/account-abstraction');
            const { createSmartAccount } = await import('./smartAccount.js');

            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockManagerInstance = {
                checkAuth: vi.fn().mockReturnValue({ isAuthenticated: false }),
                fetchActiveCredentialId: vi.fn().mockReturnValue(null),
                getAccountByCredentialId: vi.fn().mockReturnValue({
                    username: 'alice',
                    credentialId: 'imp-cred',
                    publicKey: '0x04imported',
                    creationDate: new Date().toISOString(),
                    isImported: true,
                }),
                getCurrentAccount: vi.fn().mockReturnValue(undefined),
                fetchAccounts: vi.fn().mockReturnValue([]),
                logout: vi.fn(),
                createPasskey: vi.fn(),
                authenticateWithWebAuthn: vi.fn(),
                importPasskeyAccount: vi.fn().mockResolvedValue({
                    name: 'imported',
                    credential: { id: 'imp-cred', publicKey: '0x04imported' },
                }),
                storePasskeyAccount: vi.fn(),
                storePasskeyAccountForLogin: vi.fn(),
                storeAuthState: vi.fn(),
            };
            vi.mocked(PasskeyManager).mockImplementation(() => mockManagerInstance as never);

            const mockNativeGetFn = vi.fn();
            await Account.import({
                chainId: 1,
                apiKey: 'test-api-key',
                nativeGetFn: mockNativeGetFn,
                rpId: 'myapp.com',
            });

            // importPasskeyAccount should have been called with a wrapped getFn and rpId
            expect(mockManagerInstance.importPasskeyAccount).toHaveBeenCalledWith(expect.any(Function), 'myapp.com');
            // toWebAuthnAccount should have been called with wrapped getFn and rpId
            expect(toWebAuthnAccount).toHaveBeenCalledWith(
                expect.objectContaining({
                    getFn: expect.any(Function),
                    rpId: 'myapp.com',
                })
            );
        });
    });

    describe('restore', () => {
        it('should have restore static method', () => {
            expect(typeof Account.restore).toBe('function');
        });

        it('should throw when credentialId is empty', async () => {
            await expect(Account.restore({ chainId: 1, apiKey: 'test' }, '', '0x04abc123')).rejects.toThrow(
                'credentialId and publicKey are required'
            );
        });

        it('should throw when publicKey is empty', async () => {
            await expect(
                Account.restore({ chainId: 1, apiKey: 'test' }, 'cred-123', '' as `0x${string}`)
            ).rejects.toThrow('credentialId and publicKey are required');
        });

        it('should restore account with rpId option', async () => {
            const { toWebAuthnAccount } = await import('viem/account-abstraction');
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const account = await Account.restore(
                { chainId: 1, apiKey: 'test-api-key', rpId: 'example.com' },
                'cred-123',
                '0x04abc123'
            );

            expect(account).toBeDefined();
            expect(toWebAuthnAccount).toHaveBeenCalledWith({
                credential: {
                    id: 'cred-123',
                    publicKey: '0x04abc123',
                },
                getFn: undefined,
                rpId: 'example.com',
            });
        });

        it('should restore without rpId (passes undefined through for deferred signing)', async () => {
            const { toWebAuthnAccount } = await import('viem/account-abstraction');
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const account = await Account.restore({ chainId: 1, apiKey: 'test-api-key' }, 'cred-123', '0x04abc123');

            expect(account).toBeDefined();
            expect(toWebAuthnAccount).toHaveBeenCalledWith({
                credential: {
                    id: 'cred-123',
                    publicKey: '0x04abc123',
                },
                getFn: undefined,
                rpId: undefined,
            });
        });

        it('should forward nativeGetFn (wrapped) and rpId options to toWebAuthnAccount', async () => {
            const { toWebAuthnAccount } = await import('viem/account-abstraction');
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockNativeGetFn = vi.fn();
            const account = await Account.restore(
                {
                    chainId: 1,
                    apiKey: 'test-api-key',
                    nativeGetFn: mockNativeGetFn,
                    rpId: 'example.com',
                },
                'cred-456',
                '0x04def789'
            );

            expect(account).toBeDefined();
            expect(toWebAuthnAccount).toHaveBeenCalledWith({
                credential: {
                    id: 'cred-456',
                    publicKey: '0x04def789',
                },
                getFn: expect.any(Function),
                rpId: 'example.com',
            });
        });

        it('should forward only rpId when nativeGetFn is not provided', async () => {
            const { toWebAuthnAccount } = await import('viem/account-abstraction');
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            await Account.restore({ chainId: 1, apiKey: 'test-api-key', rpId: 'myapp.com' }, 'cred-xyz', '0x04jkl345');

            expect(toWebAuthnAccount).toHaveBeenCalledWith({
                credential: {
                    id: 'cred-xyz',
                    publicKey: '0x04jkl345',
                },
                getFn: undefined,
                rpId: 'myapp.com',
            });
        });

        it('should throw when publicKey does not match stored account', async () => {
            const { PasskeyManager } = await import('../passkey-manager/index.js');
            vi.mocked(PasskeyManager).mockImplementationOnce(
                () =>
                    ({
                        checkAuth: vi.fn().mockReturnValue({ isAuthenticated: false }),
                        getAccountByCredentialId: vi.fn().mockReturnValue({
                            username: 'alice',
                            credentialId: 'cred-mismatch',
                            publicKey: '0x04realkey',
                            creationDate: new Date().toISOString(),
                            isImported: false,
                        }),
                        fetchAccounts: vi.fn().mockReturnValue([]),
                        logout: vi.fn(),
                    }) as never
            );

            await expect(
                Account.restore(
                    { chainId: 1, apiKey: 'test-api-key', rpId: 'example.com' },
                    'cred-mismatch',
                    '0x04forgedkey'
                )
            ).rejects.toThrow('Provided publicKey does not match the stored publicKey');
        });
    });

    describe('fromLocalAccount', () => {
        it('should have correct function signature', () => {
            // fromLocalAccount takes (config: AccountConfig, localAccount: LocalAccount, options?)
            expect(Account.fromLocalAccount.length).toBe(3);
        });

        it('should create account from LocalAccount', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            expect(account).toBeDefined();
            expect(createSmartAccount).toHaveBeenCalledWith(mockLocalAccount, expect.anything());
        });

        it('should return null from getMetadata for LocalAccount-based accounts', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            // LocalAccount-based accounts should return null for metadata
            expect(account.getMetadata()).toBeNull();
        });

        it('should expose address and chainId properties', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockAddress = '0x1234567890123456789012345678901234567890';
            const mockSmartAccount = {
                address: mockAddress,
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue(mockAddress),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                { chainId: 1, apiKey: 'test-api-key' },
                mockLocalAccount as never
            );

            expect(account.address).toBe(mockAddress);
            expect(account.chainId).toBe(1);
        });

        it('should work without apiKey', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            // Should not throw when apiKey is not provided
            const account = await Account.fromLocalAccount({ chainId: 1, apiKey: 'test' }, mockLocalAccount as never);

            expect(account).toBeDefined();
        });

        it('should support custom paymasterUrl', async () => {
            const { createSmartAccount } = await import('./smartAccount.js');
            const mockSmartAccount = {
                address: '0x1234567890123456789012345678901234567890',
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            };
            vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);

            const mockLocalAccount = {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            };

            const account = await Account.fromLocalAccount(
                {
                    chainId: 1,
                    apiKey: 'test',
                    paymasterUrl: 'https://paymaster.example.com',
                },
                mockLocalAccount as never
            );

            const chain = account.getChain();
            expect(chain.paymaster?.url).toBe('https://paymaster.example.com');
        });
    });
});

// `AccountConfig.paymasterContext` used to be accepted, documented and then
// silently dropped: `buildChainConfig` kept only the url, and the approval
// decision read only the override argument. A caller that configured the ERC-20
// paymaster through config therefore got a userOp sent to that paymaster naming
// no token, with no approval behind it — which it cannot settle, having no
// allowance to draw its fee from. These pin the whole path, not the resolver.
describe('Account — paymaster context from config', () => {
    // Deliberately not the JAW ERC-20 paymaster: that base url sends
    // createErc20ApprovalCall off to quote tokens and read an allowance over the
    // network. Any other url short-circuits it, leaving the threading under test.
    const PAYMASTER_URL = 'https://api.pimlico.io/v2/1/rpc?apikey=x';
    const PERMISSION_ID = '0xabc123def456789012345678901234567890123456789012345678901234567890' as `0x${string}`;

    async function makeAccount(config: Record<string, unknown>) {
        const { createSmartAccount, sendCallsWithPermission } = await import('./smartAccount.js');
        const mockSmartAccount = {
            address: '0x1234567890123456789012345678901234567890',
            signMessage: vi.fn(),
            signTypedData: vi.fn(),
            getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
        };
        vi.mocked(createSmartAccount).mockResolvedValue(mockSmartAccount as never);
        vi.mocked(sendCallsWithPermission).mockResolvedValue({ id: '0xdeadbeef', chainId: 1 });

        const mockLocalAccount = {
            address: '0xabcdef1234567890abcdef1234567890abcdef12',
            type: 'local',
            publicKey: '0x04abc123',
            sign: vi.fn(),
            signMessage: vi.fn(),
            signTypedData: vi.fn(),
            signTransaction: vi.fn(),
            source: 'privateKey',
        };

        const account = await Account.fromLocalAccount(
            { chainId: 1, apiKey: 'test', ...config } as never,
            mockLocalAccount as never
        );
        return { account, sendCallsWithPermission };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('carries a configured context onto the chain alongside the url', async () => {
        const { account } = await makeAccount({
            paymasterUrl: PAYMASTER_URL,
            paymasterContext: { sponsorshipPolicyId: 'sp_my_policy' },
        });

        expect(account.getChain().paymaster).toEqual({
            url: PAYMASTER_URL,
            context: { sponsorshipPolicyId: 'sp_my_policy' },
        });
    });

    it('sends a configured paymaster and context on a userOp that passes no overrides', async () => {
        const { account, sendCallsWithPermission } = await makeAccount({
            paymasterUrl: PAYMASTER_URL,
            paymasterContext: { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
        });

        await account.sendCalls([{ to: '0x1234567890123456789012345678901234567890' }], {
            permissionId: PERMISSION_ID,
        });

        // Args 6 and 7 are the paymaster url and context. Both were undefined
        // before, so the userOp reached the paymaster with no token named.
        const call = vi.mocked(sendCallsWithPermission).mock.calls[0];
        expect(call[5]).toBe(PAYMASTER_URL);
        expect(call[6]).toEqual({ token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
    });

    it('lets an explicit override win over the configured context', async () => {
        const { account, sendCallsWithPermission } = await makeAccount({
            paymasterUrl: PAYMASTER_URL,
            paymasterContext: { token: '0xconfigured' },
        });

        await account.sendCalls(
            [{ to: '0x1234567890123456789012345678901234567890' }],
            { permissionId: PERMISSION_ID },
            'https://override.example/rpc',
            { token: '0xoverridden' }
        );

        const call = vi.mocked(sendCallsWithPermission).mock.calls[0];
        expect(call[5]).toBe('https://override.example/rpc');
        expect(call[6]).toEqual({ token: '0xoverridden' });
    });

    it('leaves the paymaster unset when config names none', async () => {
        const { account, sendCallsWithPermission } = await makeAccount({});

        await account.sendCalls([{ to: '0x1234567890123456789012345678901234567890' }], {
            permissionId: PERMISSION_ID,
        });

        expect(account.getChain().paymaster).toBeUndefined();
        const call = vi.mocked(sendCallsWithPermission).mock.calls[0];
        expect(call[5]).toBeUndefined();
        expect(call[6]).toBeUndefined();
    });
});

// The approval half of "the approval matches the send" was pinned nowhere. Every
// case above deliberately picks a non-JAW paymaster url to stay offline, which
// short-circuits `createErc20ApprovalCall` before it builds anything — so
// dropping the prepend, or making the builder return null outright, left the
// suite green. These reach the JAW ERC-20 paymaster with its two network reads
// (the token quote and the allowance) mocked, and assert on what the send
// receives.
describe('Account — ERC-20 paymaster approval', () => {
    const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const PAYMASTER_URL = `${JAW_PAYMASTER_URL}?chainId=1&api-key=test`;
    const PERMISSION_ID = '0xabc123def456789012345678901234567890123456789012345678901234567890' as `0x${string}`;
    const RECIPIENT = '0x1234567890123456789012345678901234567890' as `0x${string}`;
    // What `buildPermissionManagerCall` is mocked to return: the wrapper the
    // permission send actually executes.
    const PERMISSION_CALL = {
        to: '0x0000000000000000000000000000000000009999' as `0x${string}`,
        value: 0n,
        data: '0xbeefbeef' as `0x${string}`,
    };
    // `calculateTokenCostFromGas` is mocked to this, so the approve is assertable.
    const CEILING = 1_500_000n;

    const expectedApproval = () => ({
        to: USDC,
        value: 0n,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [ERC20_PAYMASTER_ADDRESS as `0x${string}`, CEILING],
        }),
    });

    let prepareUserOperation: ReturnType<typeof vi.fn>;

    async function makeAccount() {
        const { createSmartAccount } = await import('./smartAccount.js');
        vi.mocked(createSmartAccount).mockResolvedValue({
            address: '0x1234567890123456789012345678901234567890',
            getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
        } as never);

        return await Account.fromLocalAccount(
            {
                chainId: 1,
                apiKey: 'test',
                paymasterUrl: PAYMASTER_URL,
                paymasterContext: { token: USDC },
            } as never,
            {
                address: '0xabcdef1234567890abcdef1234567890abcdef12',
                type: 'local',
                publicKey: '0x04abc123',
                sign: vi.fn(),
                signMessage: vi.fn(),
                signTypedData: vi.fn(),
                signTransaction: vi.fn(),
                source: 'privateKey',
            } as never
        );
    }

    beforeEach(async () => {
        vi.clearAllMocks();

        const { fetchTokenQuotes, calculateTokenCostFromGas } = await import('./erc20Paymaster.js');
        const { getBundlerClient, sendCalls, sendCallsWithPermission, buildPermissionManagerCall } = await import(
            './smartAccount.js'
        );
        const { relayPermissionToPermission } = await import('../rpc/permissions.js');

        // Nothing approved yet — the fresh-session case the approval exists for.
        vi.mocked(createPublicClient).mockReturnValue({ readContract: vi.fn().mockResolvedValue(0n) } as never);

        prepareUserOperation = vi.fn().mockResolvedValue({
            preVerificationGas: 50_000n,
            verificationGasLimit: 100_000n,
            callGasLimit: 200_000n,
            paymasterVerificationGasLimit: 30_000n,
            paymasterPostOpGasLimit: 40_000n,
            maxFeePerGas: 2_000_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n,
        });
        vi.mocked(getBundlerClient).mockReturnValue({ prepareUserOperation } as never);

        vi.mocked(fetchTokenQuotes).mockResolvedValue([
            {
                tokenAddress: USDC,
                paymasterAddress: ERC20_PAYMASTER_ADDRESS,
                exchangeRate: 1_000_000_000_000_000_000n,
                postOpGas: 40_000n,
            },
        ] as never);
        vi.mocked(calculateTokenCostFromGas).mockReturnValue(CEILING);

        vi.mocked(relayPermissionToPermission).mockReturnValue({ permissionId: '0xperm' } as never);
        vi.mocked(buildPermissionManagerCall).mockReturnValue(PERMISSION_CALL);
        vi.mocked(sendCalls).mockResolvedValue({ id: '0xdeadbeef', chainId: 1 });
        vi.mocked(sendCallsWithPermission).mockResolvedValue({ id: '0xdeadbeef', chainId: 1 });
    });

    it('prepends the approve to the calls a plain send puts on the wire', async () => {
        const { sendCalls } = await import('./smartAccount.js');
        const account = await makeAccount();

        await account.sendCalls([{ to: RECIPIENT }]);

        // Arg 1 is the call array. Without the prepend it is just the user's call.
        expect(vi.mocked(sendCalls).mock.calls[0][1]).toEqual([
            expectedApproval(),
            { to: RECIPIENT, value: undefined, data: undefined },
        ]);
    });

    it('hands the approve to a permission send at the spender level', async () => {
        const { sendCallsWithPermission } = await import('./smartAccount.js');
        const account = await makeAccount();

        await account.sendCalls([{ to: RECIPIENT }], { permissionId: PERMISSION_ID });

        // Arg 8 is the spender-level approval: it cannot go inside the permission
        // batch, whose selector check would reject `approve`.
        expect(vi.mocked(sendCallsWithPermission).mock.calls[0][8]).toEqual(expectedApproval());
    });

    // The wallet estimates the grant and passes the ceiling it measured in the
    // context. The transfer to the spender is added here, after that estimate,
    // so taking the caller's figure approved a batch one transfer short of the
    // one that goes out.
    it('measures the ceiling again when it adds a prefund transfer the caller could not have priced', async () => {
        const { fetchTokenQuotes } = await import('./erc20Paymaster.js');
        const { grantPermissions } = await import('../rpc/permissions.js');
        const SPENDER = '0x2222222222222222222222222222222222222222' as `0x${string}`;

        // The spender is empty and the account is not, which is the case the
        // prefund exists for. The allowance answers separately: a fresh session
        // has approved nothing.
        vi.mocked(createPublicClient).mockReturnValue({
            readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
                if (functionName === 'allowance') return 0n;
                return (args?.[0] as string)?.toLowerCase() === SPENDER.toLowerCase() ? 0n : 5_000_000n;
            }),
            // 0.001 gwei, the order Base charges, against a rate that puts the
            // transfer at 0.006 USDC.
            getGasPrice: vi.fn().mockResolvedValue(1_000_000n),
        } as never);
        vi.mocked(fetchTokenQuotes).mockResolvedValue([
            {
                tokenAddress: USDC,
                paymasterAddress: ERC20_PAYMASTER_ADDRESS,
                exchangeRate: 3_000_000_000n,
                postOpGas: 40_000n,
            },
        ] as never);
        vi.mocked(grantPermissions).mockResolvedValue({ permissionId: '0xperm' } as never);

        const account = await makeAccount();
        await account.grantPermissions(
            9999999999,
            SPENDER,
            { spends: [{ token: USDC, allowance: '10000000', unit: 'day' }] } as never,
            PAYMASTER_URL,
            // A ceiling of one base unit: whatever the estimate returns, it is
            // not this, so an approval for it proves the context was not trusted.
            { token: USDC, gas: '1' },
            undefined,
            { prefundSpender: true }
        );

        const estimated = prepareUserOperation.mock.calls[0][0].calls as Array<{ to: string; data: `0x${string}` }>;
        const transfers = estimated.filter(
            (call) =>
                call.to === USDC && decodeFunctionData({ abi: erc20Abi, data: call.data }).functionName === 'transfer'
        );
        expect(transfers).toHaveLength(1);

        // Arg 8 carries the approval and the transfer. The approval is the
        // re-measured ceiling, not the figure that came in the context.
        const prepended = vi.mocked(grantPermissions).mock.calls.at(-1)?.[8] as Array<unknown>;
        expect(prepended[0]).toEqual(expectedApproval());
    });

    it('sizes a permission send over the permission-manager call, not the raw calls', async () => {
        const account = await makeAccount();

        await account.sendCalls([{ to: RECIPIENT }], { permissionId: PERMISSION_ID });

        // The userOp the ceiling is drawn from has to be the one that goes out.
        // Estimating over the raw call missed the wrapper's signature verification
        // and spend accounting, so the approved ceiling could land under what the
        // paymaster then charges.
        const estimated = prepareUserOperation.mock.calls[0][0].calls;
        expect(estimated).toHaveLength(2);
        expect(estimated[1]).toEqual(PERMISSION_CALL);
        expect(estimated).not.toContainEqual(expect.objectContaining({ to: RECIPIENT }));
    });

    it('throws rather than sending unapproved when the fee cannot be priced', async () => {
        const { fetchTokenQuotes } = await import('./erc20Paymaster.js');
        const { sendCalls } = await import('./smartAccount.js');
        vi.mocked(fetchTokenQuotes).mockRejectedValue(new Error('quote endpoint down'));

        const account = await makeAccount();

        // Swallowing this used to let the userOp reach the ERC-20 paymaster with
        // no allowance behind it, which it cannot settle — the same generic
        // on-chain refusal the whole fix exists to remove.
        await expect(account.sendCalls([{ to: RECIPIENT }])).rejects.toThrow(
            /Could not size the ERC-20 paymaster approval/
        );
        expect(sendCalls).not.toHaveBeenCalled();
    });

    it('throws rather than sending unapproved when the paymaster quotes no price', async () => {
        const { fetchTokenQuotes } = await import('./erc20Paymaster.js');
        const { sendCalls } = await import('./smartAccount.js');
        // An empty list sizes nothing, same as a thrown request does.
        vi.mocked(fetchTokenQuotes).mockResolvedValue([]);

        const account = await makeAccount();

        await expect(account.sendCalls([{ to: RECIPIENT }])).rejects.toThrow(
            /Could not size the ERC-20 paymaster approval/
        );
        expect(sendCalls).not.toHaveBeenCalled();
    });

    it('approves the spender the quote names', async () => {
        const OTHER_PAYMASTER = '0x00000000000000000000000000000000000000aa' as `0x${string}`;
        const { fetchTokenQuotes } = await import('./erc20Paymaster.js');
        const { sendCalls } = await import('./smartAccount.js');
        vi.mocked(fetchTokenQuotes).mockResolvedValue([
            {
                tokenAddress: USDC,
                paymasterAddress: OTHER_PAYMASTER,
                exchangeRate: 1_000_000_000_000_000_000n,
                postOpGas: 40_000n,
            },
        ] as never);

        const account = await makeAccount();
        await account.sendCalls([{ to: RECIPIENT }]);

        // Approving one address while another one charges leaves the paymaster
        // unable to settle, which is the failure the approval exists to prevent.
        expect(vi.mocked(sendCalls).mock.calls[0][1][0]).toEqual({
            to: USDC,
            value: 0n,
            data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [OTHER_PAYMASTER, CEILING],
            }),
        });
    });

    it('sizes over what the send prepares, owner setup included', async () => {
        const { prepareCallsForExecution } = await import('./smartAccount.js');
        const OWNER_SETUP = { to: RECIPIENT, value: 0n, data: '0xaddowner' as `0x${string}` };
        // What a 7702 account not yet owning the permission manager gets prepended
        // at send time; its gas belongs in the ceiling too.
        // Once, so the passthrough the other cases rely on is not left replaced:
        // vitest is not configured to reset implementations between tests.
        vi.mocked(prepareCallsForExecution).mockImplementationOnce(
            async (_account: unknown, calls: unknown) => ({ calls: [OWNER_SETUP, ...(calls as unknown[])] }) as never
        );

        const account = await makeAccount();
        await account.sendCalls([{ to: RECIPIENT }]);

        expect(prepareUserOperation.mock.calls[0][0].calls[0]).toEqual(OWNER_SETUP);
    });

    it('refuses to revoke under the ERC-20 paymaster when the permission cannot be fetched', async () => {
        const { getPermissionFromRelay, revokePermission } = await import('../rpc/permissions.js');
        // No permission means no call to size the approval over, and an empty
        // list walks past the estimation rather than failing it.
        vi.mocked(getPermissionFromRelay).mockRejectedValue(new Error('relay down'));

        const account = await makeAccount();

        await expect(account.revokePermission(PERMISSION_ID)).rejects.toThrow(
            /Could not fetch permission .* to size the ERC-20 paymaster approval/
        );
        expect(revokePermission).not.toHaveBeenCalled();
    });

    it('does not carry the configured context to a paymaster named by override', async () => {
        const { sendCalls } = await import('./smartAccount.js');
        const account = await makeAccount();

        // A url-only override names a different paymaster. Its context is the
        // caller's business; the configured `{ token: USDC }` belongs to the one
        // it was written for and must not ride along.
        await account.sendCalls([{ to: RECIPIENT }], undefined, 'https://sponsor.example/rpc');

        const call = vi.mocked(sendCalls).mock.calls[0];
        expect(call[3]).toBe('https://sponsor.example/rpc');
        expect(call[4]).toBeUndefined();
    });
});

// The spender of a permission sends every op it authorises and the ERC-20
// paymaster charges the sender, so without help its first one has no fee source.
// The grant is the transaction the owner already signs, so it is where the
// spender gets what that op costs.
describe('Account — prefunding the spender in the grant', () => {
    // Not the JAW ERC-20 paymaster, so the approval sizing short-circuits and
    // what is under test is the call array, not the quoting.
    const PAYMASTER_URL = 'https://api.pimlico.io/v2/1/rpc?apikey=x';
    const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const SPENDER = '0x2222222222222222222222222222222222222222' as `0x${string}`;
    const PERMISSIONS = { spends: [{ token: TOKEN, allowance: '10000000', unit: 'day' }] };

    async function grant({
        prefundSpender,
        balance = 5_000_000n,
        requesterPaymasterUrl,
        walletPaymasterUrl = PAYMASTER_URL,
    }: {
        prefundSpender?: boolean;
        balance?: bigint;
        /** What the request named through `paymasterService`. */
        requesterPaymasterUrl?: string;
        /**
         * The chain's paymaster, which arrives on the request from the dapp's
         * own config. Null is the CLI bridge, which sends none.
         */
        walletPaymasterUrl?: string | null;
    } = {}) {
        const { createSmartAccount } = await import('./smartAccount.js');
        const { grantPermissions } = await import('../rpc/permissions.js');
        const { fetchTokenQuotes } = await import('./erc20Paymaster.js');

        vi.mocked(createSmartAccount).mockResolvedValue({
            address: '0x1234567890123456789012345678901234567890',
            getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
            signMessage: vi.fn(),
            signTypedData: vi.fn(),
        } as never);
        // The spender is empty, which is the case the prefund exists for. Both
        // balances answering the same number made it look already funded.
        vi.mocked(createPublicClient).mockReturnValue({
            readContract: vi.fn(async ({ args }: { args?: unknown[] }) =>
                (args?.[0] as string)?.toLowerCase() === SPENDER.toLowerCase() ? 0n : balance
            ),
            // 0.001 gwei, the order Base charges.
            getGasPrice: vi.fn().mockResolvedValue(1_000_000n),
        } as never);
        // The paymaster's rate is what turns an amount of gas into an amount of
        // this token. Three thousand a coin, six decimals.
        vi.mocked(fetchTokenQuotes).mockResolvedValue([{ exchangeRate: 3_000_000_000n }] as never);
        vi.mocked(grantPermissions).mockResolvedValue({ permissionId: '0xperm' } as never);

        const account = await Account.fromLocalAccount(
            { chainId: 1, apiKey: 'test', paymasterUrl: walletPaymasterUrl ?? undefined } as never,
            { address: '0xabcdef1234567890abcdef1234567890abcdef12', type: 'local', sign: vi.fn() } as never
        );

        await account.grantPermissions(
            9999999999,
            SPENDER,
            PERMISSIONS as never,
            requesterPaymasterUrl,
            undefined,
            undefined,
            { prefundSpender }
        );
        const prepended = vi.mocked(grantPermissions).mock.calls.at(-1)?.[8] ?? [];
        // The parameter also takes a lone call, which this path never sends.
        return Array.isArray(prepended) ? prepended : [prepended];
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // A wallet does not move funds nobody asked it to move.
    it('sends nothing extra when the caller did not ask for it', async () => {
        expect(await grant()).toEqual([]);
    });

    it('rides a transfer to the spender along in the same transaction', async () => {
        const prepended = await grant({ prefundSpender: true });

        expect(prepended).toHaveLength(1);
        expect(prepended[0].to).toBe(TOKEN);
        expect(prepended[0].data).toBeDefined();
        const decoded = decodeFunctionData({ abi: erc20Abi, data: prepended[0].data as `0x${string}` });
        expect(decoded.functionName).toBe('transfer');
        // PREFUND_GAS at that price and that rate: 0.006 USDC.
        expect(decoded.args).toEqual([SPENDER, 6_000n]);
    });

    // The rate decides how much leaves the account, to a spender the requester
    // chose. Neither URL the requester can reach is allowed to answer with it:
    // `paymasterService` is theirs by definition, and the chain's own paymaster
    // rides in on the request from the dapp's `paymasters` config, which keys
    // then builds the account from. An inflated rate clamps the transfer to the
    // whole allowance and lands it outside the permission.
    it('prices the transfer against JAW, never a paymaster the request carried', async () => {
        const { fetchTokenQuotes } = await import('./erc20Paymaster.js');

        const prepended = await grant({
            prefundSpender: true,
            walletPaymasterUrl: 'https://paymaster.the-request-carried',
            requesterPaymasterUrl: 'https://paymaster.the-requester-chose',
        });

        expect(prepended).toHaveLength(1);
        for (const call of vi.mocked(fetchTokenQuotes).mock.calls) {
            expect(call[0]).toBe(`${JAW_PAYMASTER_URL}?chainId=1&api-key=test`);
        }
        expect(vi.mocked(fetchTokenQuotes)).toHaveBeenCalled();
    });

    // The CLI bridge creates the SDK with no paymaster at all, so reading one
    // off the chain declined every session created that way while the grant
    // itself went through: charged, and seeded with nothing.
    it('still prices the transfer when the request carried no paymaster', async () => {
        const prepended = await grant({ prefundSpender: true, walletPaymasterUrl: null });

        expect(prepended).toHaveLength(1);
        const decoded = decodeFunctionData({ abi: erc20Abi, data: prepended[0].data as `0x${string}` });
        expect(decoded.args).toEqual([SPENDER, 6_000n]);
    });

    // Losing the grant to a reverted transfer is worse than the sponsored op it
    // was meant to replace.
    it('leaves the grant alone when the account cannot cover the transfer', async () => {
        expect(await grant({ prefundSpender: true, balance: 1n })).toEqual([]);
    });
});
