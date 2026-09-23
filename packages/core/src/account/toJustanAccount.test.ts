import * as viem from 'viem';
import { type Hex } from 'viem';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toJustanAccount } from './toJustanAccount.js';
import { CONTRACT_NAME, CONTRACT_VERSION } from '../constants.js';

vi.mock('viem/actions', () => ({
    readContract: vi.fn(),
    getChainId: vi.fn(),
    getTransactionCount: vi.fn(),
    signAuthorization: vi.fn(),
}));

vi.mock('viem/account-abstraction', () => ({
    toSmartAccount: vi.fn(),
    entryPoint08Abi: [],
    entryPoint08Address: '0x0000000000000000000000000000000000000000',
    getUserOperationTypedData: vi.fn(),
}));

/** The tuple JustanAccount decodes a wrapped signature into. */
const WRAPPED_SIGNATURE = [
    {
        type: 'tuple',
        components: [
            { name: 'ownerIndex', type: 'uint256' },
            { name: 'signatureData', type: 'bytes' },
        ],
    },
] as const;

const MOCK_SIGNATURE = '0x1234' as Hex;
const MOCK_ADDRESS = '0x1234567890123456789012345678901234567890' as const;
const MOCK_FACTORY_ADDRESS = '0xfac70000000000000000000000000000000fac70' as const;
const MOCK_DELEGATION_CONTRACT = '0xde1e6a7100000000000000000000000000de1e6a' as const;
const MOCK_PUBLIC_CLIENT = { chain: { id: 1 } } as any;
const MOCK_MESSAGE = 'Hello, world!';
const MOCK_TYPED_DATA = {
    domain: { name: 'Test', version: '1' },
    types: { Test: [{ name: 'value', type: 'string' }] },
    primaryType: 'Test' as const,
    message: { value: 'test' },
};
// Mail/Person with the full domain declared: the primary type sorts first, so
// this validated before and its bytes must not move.
const MAIL_TYPED_DATA = {
    domain: {
        name: 'Ether Mail',
        version: '1',
        chainId: 1,
        verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
    },
    types: {
        EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
        ],
        Person: [
            { name: 'name', type: 'string' },
            { name: 'wallet', type: 'address' },
        ],
        Mail: [
            { name: 'from', type: 'Person' },
            { name: 'to', type: 'Person' },
            { name: 'contents', type: 'string' },
        ],
    },
    primaryType: 'Mail' as const,
    message: {
        from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
        to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
        contents: 'Hello, Bob!',
    },
} as const;

describe('toJustanAccount unit tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    describe('toJustanAccount function unit tests', () => {
        describe('EIP-7702 mode detection', () => {
            it('should detect EIP-7702 mode with eip7702Account', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(readContract).toHaveBeenCalledWith(
                    MOCK_PUBLIC_CLIENT,
                    expect.objectContaining({
                        address: MOCK_FACTORY_ADDRESS,
                        functionName: 'getImplementation',
                    })
                );
            });

            it('should validate auth address matches delegation contract', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const mockAuth = {
                    address: MOCK_DELEGATION_CONTRACT,
                    chainId: 1,
                    nonce: 0,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    eip7702Auth: mockAuth,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                // A matching delegate is accepted. The sibling test covers the
                // mismatch, and between them they pin the check itself rather
                // than the fact that some comparison ran.
                expect(toSmartAccount).toHaveBeenCalled();
            });

            it('should throw error when auth address does not match delegation contract', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const mockAuth = {
                    address: '0xbad0000000000000000000000000000000000bad' as const,
                    chainId: 1,
                    nonce: 0,
                } as any;

                const { readContract } = await import('viem/actions');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);

                await expect(
                    toJustanAccount({
                        client: MOCK_PUBLIC_CLIENT,
                        owners: [],
                        eip7702Account: mockEOA,
                        eip7702Auth: mockAuth,
                        factoryAddress: MOCK_FACTORY_ADDRESS,
                    })
                ).rejects.toThrow('EIP-7702 authorization delegate address does not match delegation contract address');
            });
        });

        describe('EIP-7702 authorization property', () => {
            // viem auto-attaches a stub-signed authorization to any userOp it
            // prepares when the account exposes `authorization` — that is what
            // keeps estimation-only flows (paymaster approval sizing) from
            // simulating a codeless sender on the first 7702 op.
            it('exposes the authority/delegate pair in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    signAuthorization: vi.fn(),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(toSmartAccount).toHaveBeenCalledWith(
                    expect.objectContaining({
                        authorization: { account: mockEOA, address: MOCK_DELEGATION_CONTRACT },
                    })
                );
            });

            it('omits authorization when the account cannot sign authorizations (remote signer)', async () => {
                // viem may call signAuthorization on the exposed account; a
                // LocalAccount without it must fall back to the old behavior.
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const implementation = vi.mocked(toSmartAccount).mock.calls.at(-1)?.[0] as Record<string, unknown>;
                expect('authorization' in implementation).toBe(false);
            });

            it('does not expose authorization in counterfactual mode', async () => {
                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [MOCK_ADDRESS],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const implementation = vi.mocked(toSmartAccount).mock.calls.at(-1)?.[0] as Record<string, unknown>;
                expect('authorization' in implementation).toBe(false);
            });
        });

        describe('Owner processing', () => {
            it('should process string owner to padded bytes', async () => {
                const mockStringOwner = MOCK_ADDRESS;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockStringOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                // The padded owner is what the factory hashes into the account
                // address, so assert the bytes rather than the call.
                expect(readContract).toHaveBeenCalledWith(
                    MOCK_PUBLIC_CLIENT,
                    expect.objectContaining({
                        args: [[`0x${'00'.repeat(12)}${mockStringOwner.slice(2)}`], 0n],
                    })
                );
            });

            it('should process WebAuthn owner to publicKey', async () => {
                const mockPublicKey = '0xpublickey1234567890' as Hex;
                const mockWebAuthnOwner = {
                    type: 'webAuthn' as const,
                    publicKey: mockPublicKey,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockWebAuthnOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(readContract).toHaveBeenCalledWith(
                    MOCK_PUBLIC_CLIENT,
                    expect.objectContaining({
                        args: expect.arrayContaining([[mockPublicKey], 0n]),
                    })
                );
            });

            it('should process Local owner to padded address', async () => {
                const mockLocalOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockLocalOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(readContract).toHaveBeenCalledWith(
                    MOCK_PUBLIC_CLIENT,
                    expect.objectContaining({
                        args: [[`0x${'00'.repeat(12)}${MOCK_ADDRESS.slice(2)}`], 0n],
                    })
                );
            });

            it('should throw error for invalid owner type', async () => {
                const mockInvalidOwner = {
                    type: 'invalid' as any,
                } as any;

                await expect(
                    toJustanAccount({
                        client: MOCK_PUBLIC_CLIENT,
                        owners: [mockInvalidOwner],
                        factoryAddress: MOCK_FACTORY_ADDRESS,
                    })
                ).rejects.toThrow('invalid owner type');
            });
        });

        describe('Owner selection', () => {
            it('should use eip7702Account as owner in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    sign: vi.fn(),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockImplementation((params: any) => {
                    expect(params).toBeDefined();
                    return {} as any;
                });

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(toSmartAccount).toHaveBeenCalled();
            });

            it('should use ownerIndex to select owner', async () => {
                const mockOwner1 = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;
                const mockOwner2 = {
                    type: 'local' as const,
                    address: '0x2222222222222222222222222222222222222222' as const,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner1, mockOwner2],
                    ownerIndex: 1,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(toSmartAccount).toHaveBeenCalled();
            });

            it('should throw error when no owner provided in EIP-7702 mode without eip7702Account', async () => {
                const mockAuth = {
                    address: MOCK_DELEGATION_CONTRACT,
                    chainId: 1,
                    nonce: 0,
                } as any;

                const { readContract } = await import('viem/actions');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);

                await expect(
                    toJustanAccount({
                        client: MOCK_PUBLIC_CLIENT,
                        owners: [],
                        eip7702Auth: mockAuth,
                        factoryAddress: MOCK_FACTORY_ADDRESS,
                    })
                ).rejects.toThrow('eip7702Account is required when using EIP-7702');
            });
        });

        describe('Account address resolution', () => {
            it('should use eip7702Account address in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockImplementation((params: any) => {
                    expect(params.getAddress).toBeDefined();
                    return {} as any;
                });

                const result = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(result).toBeDefined();
            });

            it('should call readContract for address in non-EIP-7702 mode', async () => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({} as any);

                await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                expect(readContract).toHaveBeenCalledWith(
                    MOCK_PUBLIC_CLIENT,
                    expect.objectContaining({
                        address: MOCK_FACTORY_ADDRESS,
                        functionName: 'getAddress',
                    })
                );
            });
        });
    });

    describe('justanAccount methods unit tests', () => {
        describe('getAddress()', () => {
            it('should return eip7702Account address in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockReturnValue({
                    getAddress: vi.fn().mockResolvedValue(MOCK_ADDRESS),
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const address = await account.getAddress();
                expect(address).toBe(MOCK_ADDRESS);
            });

            it('should return computed address in non-EIP-7702 mode', async () => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({
                    getAddress: vi.fn().mockResolvedValue(MOCK_ADDRESS),
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const address = await account.getAddress();
                expect(address).toBe(MOCK_ADDRESS);
            });
        });

        describe('getStubSignature()', () => {
            it('should return short signature in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockReturnValue({
                    getStubSignature: vi
                        .fn()
                        .mockResolvedValue(
                            '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'
                        ),
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const stubSig = await account.getStubSignature();
                expect(stubSig).toBe(
                    '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'
                );
            });

            it('should return long signature in non-EIP-7702 mode', async () => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                const longSig =
                    '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000170000000000000000000000000000000000000000000000000000000000000001949fc7c88032b9fcb5f6efc7a7b8c63668eae9871b765e23123bb473ff57aa831a7c0d9276168ebcc29f2875a0239cffdf2a9cd1c2007c5c77c071db9264df1d000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763050000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000847b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a2273496a396e6164474850596759334b7156384f7a4a666c726275504b474f716d59576f4d57516869467773222c226f726967696e223a2268747470733a2f2f6b6579732e6a61772e6964222c2263726f73734f726967696e223a66616c73657d00000000000000000000000000000000000000000000000000000000';
                vi.mocked(toSmartAccount).mockReturnValue({
                    getStubSignature: vi.fn().mockResolvedValue(longSig),
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const stubSig = await account.getStubSignature();
                expect(stubSig).toBe(longSig);
            });
        });

        describe('getFactoryArgs()', () => {
            it('should return undefined values in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockReturnValue({
                    getFactoryArgs: vi.fn().mockResolvedValue({
                        factory: undefined,
                        factoryData: undefined,
                    }),
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const factoryArgs = await account.getFactoryArgs();
                expect(factoryArgs.factory).toBeUndefined();
                expect(factoryArgs.factoryData).toBeUndefined();
            });

            it('should return factory address and encoded data in non-EIP-7702 mode', async () => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const mockEncodedData = '0xencodeddata' as Hex;
                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockReturnValue({
                    getFactoryArgs: vi.fn().mockResolvedValue({
                        factory: MOCK_FACTORY_ADDRESS,
                        factoryData: mockEncodedData,
                    }),
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const factoryArgs = await account.getFactoryArgs();
                expect(factoryArgs.factory).toBe(MOCK_FACTORY_ADDRESS);
                expect(factoryArgs.factoryData).toBe(mockEncodedData);
            });
        });

        describe('signMessage()', () => {
            it('should return raw signature in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    sign: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockImplementation((params: any) => ({
                    ...params,
                }));

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const signature = await account.signMessage({ message: MOCK_MESSAGE });

                expect(mockEOA.sign).toHaveBeenCalled();
                expect(signature).toBe(MOCK_SIGNATURE);
            });

            it('should return wrapped signature in non-EIP-7702 mode', async () => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    sign: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockImplementation((params: any) => ({
                    ...params,
                }));

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const signature = await account.signMessage({ message: MOCK_MESSAGE });

                // What gets signed is an ERC-7739 digest bound to this account
                // through the verifier domain. Signing a plain message hash
                // instead would be a replay-shaped change, and nothing else here
                // would notice.
                const { hashMessage: erc7739HashMessage } = await import('viem/experimental/erc7739');
                expect(mockOwner.sign).toHaveBeenCalledWith({
                    hash: erc7739HashMessage({
                        message: MOCK_MESSAGE,
                        verifierDomain: {
                            name: CONTRACT_NAME,
                            version: CONTRACT_VERSION,
                            verifyingContract: MOCK_ADDRESS,
                            chainId: MOCK_PUBLIC_CLIENT.chain.id,
                        },
                    }),
                });

                // Decoded, not "was called": the wrapping is what the contract
                // reads, and toJustanAccount.encoding.test.ts pins its shape.
                const [wrapped] = viem.decodeAbiParameters(WRAPPED_SIGNATURE, signature);
                expect(wrapped.ownerIndex).toBe(0n);
                expect(wrapped.signatureData).toBe(MOCK_SIGNATURE);
            });

            it('should throw error for address-type owner', async () => {
                const mockAddressOwner = MOCK_ADDRESS;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);

                const mockSignMessage = vi.fn().mockRejectedValue(new Error('owner cannot sign'));
                vi.mocked(toSmartAccount).mockReturnValue({
                    signMessage: mockSignMessage,
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockAddressOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                await expect(account.signMessage({ message: MOCK_MESSAGE })).rejects.toThrow('owner cannot sign');
            });
        });

        describe('signTypedData()', () => {
            it('should wrap the raw signature in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    sign: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(toSmartAccount).mockImplementation((params: any) => ({
                    ...params,
                }));

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const signature = await account.signTypedData(MOCK_TYPED_DATA);

                expect(mockEOA.sign).toHaveBeenCalled();
                const { wrapTypedDataSignature } = await import('viem/experimental/erc7739');
                expect(signature).toBe(wrapTypedDataSignature({ ...MOCK_TYPED_DATA, signature: MOCK_SIGNATURE }));
            });

            it.each([
                ['a primary type with no dependencies', MOCK_TYPED_DATA],
                ['Mail/Person with a declared domain', MAIL_TYPED_DATA],
            ])('should wrap typed data byte for byte as viem does for %s', async (_, typedData) => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    sign: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(toSmartAccount).mockImplementation((params: any) => ({
                    ...params,
                }));

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const signature = await account.signTypedData(typedData as never);

                expect(mockOwner.sign).toHaveBeenCalled();
                // The ERC-7739 envelope carries the domain the verifier checks.
                // A prefix check would pass with the envelope dropped entirely,
                // so compare against the whole thing.
                // The envelope goes around the owner tuple, not inside it, so
                // decoding the tuple off the front reads right past it. Assert
                // the whole value: the inner tuple built from the shape written
                // out above, wrapped by viem's own helper. When the primary type
                // sorts first, deployed accounts already accept these bytes, so
                // they must stay identical.
                const { wrapTypedDataSignature } = await import('viem/experimental/erc7739');
                const inner = viem.encodeAbiParameters(WRAPPED_SIGNATURE, [
                    { ownerIndex: 0n, signatureData: MOCK_SIGNATURE },
                ]);
                expect(signature).toBe(wrapTypedDataSignature({ ...typedData, signature: inner } as never));
            });

            it('should throw error for address-type owner', async () => {
                const mockAddressOwner = MOCK_ADDRESS;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);

                const mockSignTypedData = vi.fn().mockRejectedValue(new Error('owner cannot sign'));
                vi.mocked(toSmartAccount).mockReturnValue({
                    signTypedData: mockSignTypedData,
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockAddressOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                await expect(account.signTypedData(MOCK_TYPED_DATA)).rejects.toThrow('owner cannot sign');
            });
        });

        describe('signUserOperation()', () => {
            it('should return raw signature in EIP-7702 mode', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    sign: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount, getUserOperationTypedData } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(getUserOperationTypedData).mockReturnValue(MOCK_TYPED_DATA as any);

                const mockSignUserOperation = vi.fn().mockResolvedValue(MOCK_SIGNATURE);
                vi.mocked(toSmartAccount).mockReturnValue({
                    signUserOperation: mockSignUserOperation,
                    getAddress: vi.fn().mockResolvedValue(MOCK_ADDRESS),
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const signature = await account.signUserOperation({
                    callData: '0x',
                    callGasLimit: 100000n,
                    verificationGasLimit: 100000n,
                    preVerificationGas: 100000n,
                    maxFeePerGas: 1n,
                    maxPriorityFeePerGas: 1n,
                } as any);

                expect(signature).toBe(MOCK_SIGNATURE);
            });

            it('should return wrapped signature in non-EIP-7702 mode', async () => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    sign: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount, getUserOperationTypedData } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);
                vi.mocked(getUserOperationTypedData).mockReturnValue(MOCK_TYPED_DATA as any);

                // Spread rather than replaced, or `account.signUserOperation`
                // would be the mock and this would assert what the mock was
                // told to return.
                vi.mocked(toSmartAccount).mockImplementation((params: any) => ({ ...params }));

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const signature = await account.signUserOperation({
                    callData: '0x',
                    callGasLimit: 100000n,
                    verificationGasLimit: 100000n,
                    preVerificationGas: 100000n,
                    maxFeePerGas: 1n,
                    maxPriorityFeePerGas: 1n,
                } as any);

                const [wrapped] = viem.decodeAbiParameters(WRAPPED_SIGNATURE, signature);
                expect(wrapped.ownerIndex).toBe(0n);
                expect(wrapped.signatureData).toBe(MOCK_SIGNATURE);
            });

            it('should throw error for address-type owner', async () => {
                const mockAddressOwner = MOCK_ADDRESS;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);

                const mockSignUserOperation = vi.fn().mockRejectedValue(new Error('owner cannot sign'));
                vi.mocked(toSmartAccount).mockReturnValue({
                    signUserOperation: mockSignUserOperation,
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockAddressOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                await expect(
                    account.signUserOperation({
                        callData: '0x',
                        callGasLimit: 100000n,
                        verificationGasLimit: 100000n,
                        preVerificationGas: 100000n,
                        maxFeePerGas: 1n,
                        maxPriorityFeePerGas: 1n,
                    } as any)
                ).rejects.toThrow('owner cannot sign');
            });
        });

        describe('signAuthorization()', () => {
            it('should return pre-signed auth if available', async () => {
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const mockAuth = {
                    address: MOCK_DELEGATION_CONTRACT,
                    chainId: 1,
                    nonce: 0,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);

                const mockSignAuthorization = vi.fn().mockResolvedValue(mockAuth);
                vi.mocked(toSmartAccount).mockReturnValue({
                    signAuthorization: mockSignAuthorization,
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    eip7702Auth: mockAuth,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const auth = await account.signAuthorization();

                expect(auth).toBe(mockAuth);
            });

            it('should use native signAuthorization if available (Tier 1)', async () => {
                const mockAuth = {
                    address: MOCK_DELEGATION_CONTRACT,
                    chainId: 1,
                    nonce: 0,
                } as any;

                const mockSignAuthorization = vi.fn().mockResolvedValue(mockAuth);
                const mockEOA = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                    signAuthorization: mockSignAuthorization,
                } as any;

                const { readContract, getChainId } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                const { getTransactionCount } = await import('viem/actions');

                vi.mocked(readContract).mockResolvedValue(MOCK_DELEGATION_CONTRACT);
                vi.mocked(getChainId).mockResolvedValue(1);
                vi.mocked(getTransactionCount).mockResolvedValue(0);
                vi.mocked(toSmartAccount).mockImplementation((params: any) => ({
                    ...params,
                }));

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [],
                    eip7702Account: mockEOA,
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                const auth = await account.signAuthorization();

                expect(getChainId).toHaveBeenCalled();
                expect(getTransactionCount).toHaveBeenCalled();
                expect(mockSignAuthorization).toHaveBeenCalledWith({
                    contractAddress: MOCK_DELEGATION_CONTRACT,
                    chainId: 1,
                    nonce: 0,
                });
                expect(auth).toEqual(mockAuth);
            });

            it('should throw error for non-EIP-7702 accounts', async () => {
                const mockOwner = {
                    type: 'local' as const,
                    address: MOCK_ADDRESS,
                } as any;

                const { readContract } = await import('viem/actions');
                const { toSmartAccount } = await import('viem/account-abstraction');
                vi.mocked(readContract).mockResolvedValue(MOCK_ADDRESS);

                const mockSignAuthorization = vi
                    .fn()
                    .mockRejectedValue(new Error('signAuthorization can only be called for EIP-7702 accounts'));
                vi.mocked(toSmartAccount).mockReturnValue({
                    signAuthorization: mockSignAuthorization,
                } as any);

                const account = await toJustanAccount({
                    client: MOCK_PUBLIC_CLIENT,
                    owners: [mockOwner],
                    factoryAddress: MOCK_FACTORY_ADDRESS,
                });

                await expect(account.signAuthorization()).rejects.toThrow(
                    'signAuthorization can only be called for EIP-7702 accounts'
                );
            });
        });
    });
});
